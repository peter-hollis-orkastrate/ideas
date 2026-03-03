#!/usr/bin/env python3
"""
Local OCR Worker for OCR Provenance MCP System

Extracts text from documents using Marker (local AI-based OCR).
No external API keys required — all processing runs on your machine.

Supported formats:
  - PDF, images (PNG/JPG/TIFF/BMP/GIF/WEBP): processed by Marker directly
  - Office files (DOCX/DOC/PPTX/PPT/XLSX/XLS): converted to PDF via LibreOffice,
    then processed by Marker
  - Text files (TXT/CSV/MD): read directly
"""

import argparse
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

# Configure logging FIRST
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


# =============================================================================
# ERROR CLASSES (CS-ERR-001 compliant - inline, no separate module)
# =============================================================================


class OCRError(Exception):
    """Base OCR error with category for error handling."""

    def __init__(self, message: str, category: str, request_id: str | None = None):
        super().__init__(message)
        self.category = category
        self.request_id = request_id


class OCRAPIError(OCRError):
    """Processing errors."""

    def __init__(self, message: str, status_code: int, request_id: str | None = None):
        category = "OCR_SERVER_ERROR" if status_code >= 500 else "OCR_API_ERROR"
        super().__init__(message, category, request_id)
        self.status_code = status_code


class OCRRateLimitError(OCRError):
    """Rate limit exceeded (not applicable for local OCR, kept for interface compatibility)."""

    def __init__(self, message: str = "Rate limit exceeded", retry_after: int = 60):
        super().__init__(message, "OCR_RATE_LIMIT")
        self.retry_after = retry_after


class OCRTimeoutError(OCRError):
    """Processing timeout."""

    def __init__(self, message: str, request_id: str | None = None):
        super().__init__(message, "OCR_TIMEOUT", request_id)


class OCRFileError(OCRError):
    """File access errors."""

    def __init__(self, message: str, file_path: str):
        super().__init__(message, "OCR_FILE_ERROR")
        self.file_path = file_path


class OCRDependencyError(OCRError):
    """Missing local dependency (Marker, LibreOffice, etc.)."""

    def __init__(self, message: str):
        super().__init__(message, "OCR_DEPENDENCY_ERROR")


# =============================================================================
# DATA STRUCTURES (match src/models/document.ts exactly)
# =============================================================================


@dataclass
class PageOffset:
    """
    Character offset for a single page.
    MUST match src/models/document.ts PageOffset interface.
    Note: TypeScript uses camelCase (charStart), Python uses snake_case (char_start).
    """

    page: int  # 1-indexed page number
    char_start: int  # Start offset in full text
    char_end: int  # End offset in full text


@dataclass
class OCRResult:
    """
    Result from OCR processing.
    MUST match src/models/document.ts OCRResult interface exactly.
    Fields formerly named 'datalab_*' are kept for backward compatibility.
    """

    # Required fields (match TypeScript interface)
    id: str  # UUID
    provenance_id: str  # UUID - caller provides
    document_id: str  # UUID - caller provides
    extracted_text: str  # Markdown text from local OCR
    text_length: int  # len(extracted_text)
    datalab_request_id: str  # Reused as local request ID (kept for TS compat)
    datalab_mode: Literal["fast", "balanced", "accurate"]  # OCR quality mode
    parse_quality_score: float | None  # Quality estimate (None = not computed)
    page_count: int
    cost_cents: float | None  # Always 0 for local processing
    content_hash: str  # sha256:... of extracted_text
    processing_started_at: str  # ISO 8601
    processing_completed_at: str  # ISO 8601
    processing_duration_ms: int

    # Additional fields for provenance
    page_offsets: list[PageOffset]  # Character offsets per page
    error: str | None = None

    # Images extracted from document (filename -> base64 data)
    images: dict[str, str] | None = None

    # JSON block hierarchy (kept for TS compat, None for local OCR)
    json_blocks: dict | None = None

    # Document metadata
    metadata: dict | None = None

    # Structured extraction result (None for local OCR)
    extraction_json: dict | list | None = None

    # Cost breakdown (always None for local processing)
    cost_breakdown_full: dict | None = None

    # Extras features (None for local OCR)
    extras_features: dict | None = None

    # Document metadata fields
    doc_title: str | None = None
    doc_author: str | None = None
    doc_subject: str | None = None


# =============================================================================
# SUPPORTED FILE TYPES (match src/models/document.ts)
# =============================================================================

SUPPORTED_EXTENSIONS = frozenset(
    {
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".tiff",
        ".tif",
        ".bmp",
        ".gif",
        ".webp",
        ".docx",
        ".doc",
        ".pptx",
        ".ppt",
        ".xlsx",
        ".xls",
        ".txt",
        ".csv",
        ".md",
    }
)

# Extensions handled directly by Marker
MARKER_EXTENSIONS = frozenset({
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".tiff",
    ".tif",
    ".bmp",
    ".gif",
    ".webp",
})

# Office extensions: convert to PDF first via LibreOffice
OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"})

# Plain text: read directly
TEXT_EXTENSIONS = frozenset({".txt", ".csv", ".md"})


# =============================================================================
# MARKER MODEL CACHE (load once, reuse across calls)
# =============================================================================

_marker_models = None


def get_marker_models():
    """Load Marker models once and cache globally."""
    global _marker_models
    if _marker_models is not None:
        return _marker_models

    logger.info("Loading Marker models (first call — this may take 30-60s)...")
    try:
        # Try marker >= 1.x API first
        try:
            from marker.models import create_model_dict
            _marker_models = create_model_dict()
            logger.info("Loaded Marker v1.x models")
        except (ImportError, AttributeError):
            # Fall back to marker 0.3.x API
            from marker.models import load_all_models
            _marker_models = load_all_models()
            logger.info("Loaded Marker v0.3.x models")
    except ImportError as e:
        raise OCRDependencyError(
            f"Marker is not installed: {e}. "
            "Install it with: pip install marker-pdf"
        ) from e

    return _marker_models


# =============================================================================
# MAIN IMPLEMENTATION
# =============================================================================


def validate_file(file_path: str) -> Path:
    """
    Validate file exists and is supported type.
    FAIL-FAST: Raises immediately on any issue.
    """
    path = Path(file_path).resolve()

    if not path.exists():
        raise OCRFileError(f"File not found: {file_path}", str(path))

    if not path.is_file():
        raise OCRFileError(f"Not a file: {file_path}", str(path))

    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise OCRFileError(
            f"Unsupported file type: {path.suffix}. "
            f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
            str(path),
        )

    return path


def compute_content_hash(content: str) -> str:
    """
    Compute SHA-256 hash matching src/utils/hash.ts format.
    Returns: 'sha256:' + 64 lowercase hex characters
    """
    hash_hex = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return f"sha256:{hash_hex}"


def parse_page_offsets(markdown: str) -> list[PageOffset]:
    """
    Parse page delimiters from Marker paginated output.
    Marker uses horizontal rules or page markers between pages.
    """
    # Marker uses '---' page separators in some configurations
    page_pattern = r"\n---\n(?:<!-- Page (\d+) -->\n)?"
    parts = re.split(page_pattern, markdown)

    if len(parts) == 1:
        return [PageOffset(page=1, char_start=0, char_end=len(markdown))]

    offsets = []
    current_offset = 0
    page_num = 1

    for i, part in enumerate(parts):
        if part is None:
            continue
        # Skip numeric page number captures from the regex
        if part and part.isdigit():
            page_num = int(part)
            continue
        content_len = len(part)
        offsets.append(PageOffset(page=page_num, char_start=current_offset,
                                   char_end=current_offset + content_len))
        current_offset += content_len
        page_num += 1

    if not offsets:
        return [PageOffset(page=1, char_start=0, char_end=len(markdown))]
    return offsets


def convert_office_to_pdf(file_path: Path, tmp_dir: str) -> Path:
    """
    Convert Office file to PDF using LibreOffice.
    Raises OCRDependencyError if LibreOffice is not installed.
    """
    try:
        result = subprocess.run(
            [
                "libreoffice",
                "--headless",
                "--convert-to", "pdf",
                "--outdir", tmp_dir,
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise OCRAPIError(
                f"LibreOffice conversion failed: {result.stderr}",
                status_code=500,
            )
        # LibreOffice outputs <filename>.pdf in tmp_dir
        pdf_path = Path(tmp_dir) / (file_path.stem + ".pdf")
        if not pdf_path.exists():
            raise OCRAPIError(
                f"LibreOffice did not create expected PDF: {pdf_path}",
                status_code=500,
            )
        return pdf_path
    except FileNotFoundError:
        raise OCRDependencyError(
            "LibreOffice is not installed. Install it to process Office files:\n"
            "  Ubuntu/Debian: sudo apt install libreoffice\n"
            "  macOS: brew install --cask libreoffice\n"
            "  Windows: download from https://www.libreoffice.org/"
        )


def run_marker_on_file(file_path: Path) -> tuple[str, dict[str, str], dict]:
    """
    Run Marker on a PDF or image file.
    Returns: (markdown_text, images_dict, metadata_dict)
    """
    models = get_marker_models()
    file_str = str(file_path)

    try:
        # Try marker >= 1.x API
        try:
            from marker.config.parser import ConfigParser
            from marker.converters.pdf import PdfConverter

            config_parser = ConfigParser({"output_format": "markdown", "force_ocr": False})
            converter = PdfConverter(
                config=config_parser.generate_config_dict(),
                artifact_dict=models,
                processor_list=config_parser.get_processors(),
                renderer=config_parser.get_renderer(),
            )
            rendered = converter(file_str)
            markdown = rendered.markdown
            images_raw = rendered.images if hasattr(rendered, "images") else {}
            metadata = rendered.metadata if hasattr(rendered, "metadata") else {}

        except (ImportError, AttributeError, TypeError):
            # Fall back to marker 0.3.x API
            from marker.convert import convert_single_pdf
            markdown, images_raw, metadata = convert_single_pdf(
                file_str, models, langs=["en"]
            )

    except Exception as e:
        raise OCRAPIError(f"Marker processing failed: {e}", status_code=500) from e

    # Convert PIL Image objects to base64 if needed
    images: dict[str, str] = {}
    for img_name, img_data in images_raw.items():
        try:
            import base64
            import io
            if hasattr(img_data, "save"):
                # PIL Image
                buf = io.BytesIO()
                img_data.save(buf, format="PNG")
                images[img_name] = base64.b64encode(buf.getvalue()).decode("utf-8")
            elif isinstance(img_data, (bytes, bytearray)):
                images[img_name] = base64.b64encode(img_data).decode("utf-8")
            elif isinstance(img_data, str):
                images[img_name] = img_data  # Already base64
        except Exception as e:
            logger.warning(f"Failed to encode image {img_name}: {e}")

    return markdown, images, metadata if isinstance(metadata, dict) else {}


def process_text_file(file_path: Path) -> tuple[str, dict]:
    """Read a plain text file directly, returning (markdown, metadata)."""
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise OCRFileError(f"Failed to read text file: {e}", str(file_path)) from e
    # Wrap CSV content in a code block for better markdown rendering
    if file_path.suffix.lower() == ".csv":
        text = f"```csv\n{text}\n```"
    metadata = {"source": "text_reader", "format": file_path.suffix.lstrip(".")}
    return text, metadata


def process_document(
    file_path: str,
    document_id: str,
    provenance_id: str,
    mode: Literal["fast", "balanced", "accurate"] = "balanced",
    timeout: int = 1800,
    # Legacy parameters kept for interface compatibility (ignored for local OCR)
    max_pages: int | None = None,
    page_range: str | None = None,
    skip_cache: bool = False,
    disable_image_extraction: bool = False,
    extras: list[str] | None = None,
    page_schema: str | None = None,
    additional_config: dict | None = None,
    file_url: str | None = None,
) -> OCRResult:
    """
    Process a document through local OCR (Marker).

    For PDFs and images: uses Marker directly.
    For Office files: converts to PDF via LibreOffice, then uses Marker.
    For text files: reads content directly.

    Args:
        file_path: Path to document (PDF, image, or Office file)
        document_id: UUID of the document record in database
        provenance_id: UUID for the OCR_RESULT provenance record
        mode: OCR quality mode (affects Marker force_ocr setting)
        timeout: Maximum processing time in seconds
        max_pages: Maximum pages to process (approximate)
        page_range: Specific pages (not supported for local OCR)
        skip_cache: Ignored for local OCR
        disable_image_extraction: Skip image extraction
        extras: Ignored for local OCR
        page_schema: Ignored for local OCR
        additional_config: Ignored for local OCR
        file_url: URL to download file from (not supported, raises error)

    Returns:
        OCRResult with extracted text and metadata
    """
    if file_url:
        raise OCRAPIError(
            "file_url is not supported by the local OCR worker. "
            "Download the file first and pass the local file_path instead.",
            status_code=400,
        )

    validated_path = validate_file(file_path)
    ext = validated_path.suffix.lower()
    logger.info(f"Processing document: {validated_path} (mode={mode}, ext={ext})")

    start_time = time.time()
    start_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    request_id = str(uuid.uuid4())

    try:
        markdown = ""
        images: dict[str, str] = {}
        metadata: dict = {}

        if ext in TEXT_EXTENSIONS:
            markdown, metadata = process_text_file(validated_path)
            page_count = 1

        elif ext in OFFICE_EXTENSIONS:
            with tempfile.TemporaryDirectory() as tmp_dir:
                logger.info(f"Converting Office file to PDF via LibreOffice: {validated_path.name}")
                pdf_path = convert_office_to_pdf(validated_path, tmp_dir)
                markdown, images, metadata = run_marker_on_file(pdf_path)

        elif ext in MARKER_EXTENSIONS:
            markdown, images, metadata = run_marker_on_file(validated_path)

        else:
            raise OCRFileError(f"No handler for extension: {ext}", str(validated_path))

        if disable_image_extraction:
            images = {}

        # Extract page count from metadata or estimate from content
        page_count = (
            metadata.get("page_count")
            or metadata.get("pages")
            or metadata.get("num_pages")
            or len(re.findall(r"\n---\n", markdown)) + 1
        )
        if not isinstance(page_count, int):
            page_count = 1

        # Honour max_pages by truncating if needed
        if max_pages and page_count > max_pages:
            logger.info(f"Truncating to {max_pages} pages (document has {page_count})")
            # Find the nth page marker and slice there
            separator_count = 0
            cut_pos = len(markdown)
            for m in re.finditer(r"\n---\n", markdown):
                separator_count += 1
                if separator_count >= max_pages:
                    cut_pos = m.start()
                    break
            markdown = markdown[:cut_pos]
            page_count = max_pages

        # Extract document metadata fields
        doc_title = metadata.get("title") or metadata.get("Title")
        doc_author = metadata.get("author") or metadata.get("Author")
        doc_subject = metadata.get("subject") or metadata.get("Subject")

        # Parse page offsets for provenance tracking
        page_offsets = parse_page_offsets(markdown)

        # Compute content hash
        content_hash = compute_content_hash(markdown)

        end_time = time.time()
        end_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        duration_ms = int((end_time - start_time) * 1000)

        ocr_result = OCRResult(
            id=str(uuid.uuid4()),
            provenance_id=provenance_id,
            document_id=document_id,
            extracted_text=markdown,
            text_length=len(markdown),
            datalab_request_id=request_id,  # Reused as local request ID
            datalab_mode=mode,
            parse_quality_score=None,  # Marker does not expose a quality score
            page_count=page_count,
            cost_cents=0.0,  # Local processing is free
            content_hash=content_hash,
            processing_started_at=start_timestamp,
            processing_completed_at=end_timestamp,
            processing_duration_ms=duration_ms,
            page_offsets=page_offsets,
            images=images if images else None,
            json_blocks=None,
            metadata=metadata if metadata else None,
            extraction_json=None,
            cost_breakdown_full=None,
            extras_features=None,
            doc_title=doc_title,
            doc_author=doc_author,
            doc_subject=doc_subject,
        )

        logger.info(
            f"OCR complete: {page_count} pages, {len(markdown)} chars, "
            f"{duration_ms}ms, cost=$0.00 (local)"
        )
        return ocr_result

    except (OCRError, OCRDependencyError):
        raise
    except Exception as e:
        logger.error(f"Unexpected error during OCR: {e}")
        raise OCRAPIError(str(e), 500, request_id) from e


# =============================================================================
# CLI INTERFACE (for manual testing)
# =============================================================================


def main() -> None:
    """CLI entry point for manual testing."""
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            load_dotenv(env_path)
    except ImportError:
        pass

    parser = argparse.ArgumentParser(
        description="Local OCR Worker (Marker) - Extract text from documents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process a PDF
  python ocr_worker.py --file ./data/document.pdf

  # Process with JSON output
  python ocr_worker.py --file ./data/document.pdf --json

  # Process Office file (requires LibreOffice)
  python ocr_worker.py --file ./data/report.docx --json
        """,
    )
    parser.add_argument("--file", "-f", type=str, help="File to process")
    parser.add_argument(
        "--mode",
        "-m",
        choices=["fast", "balanced", "accurate"],
        default="balanced",
        help="OCR mode (default: balanced)",
    )
    parser.add_argument("--doc-id", type=str, help="Document ID (UUID)")
    parser.add_argument("--prov-id", type=str, help="Provenance ID (UUID)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--max-pages", type=int, help="Max pages to process")
    parser.add_argument(
        "--disable-image-extraction", action="store_true", help="Skip image extraction"
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Timeout in seconds (default: 1800)",
    )

    args = parser.parse_args()

    if args.json:
        logging.getLogger().setLevel(logging.CRITICAL)

    if not args.file:
        parser.error("--file is required")

    try:
        doc_id = args.doc_id or str(uuid.uuid4())
        prov_id = args.prov_id or str(uuid.uuid4())

        result = process_document(
            args.file,
            document_id=doc_id,
            provenance_id=prov_id,
            mode=args.mode,
            timeout=args.timeout,
            max_pages=args.max_pages,
            disable_image_extraction=args.disable_image_extraction,
        )

        if args.json:
            print(json.dumps(asdict(result)))
        else:
            print("=== OCR Result ===")
            print(f"Pages: {result.page_count}")
            print(f"Characters: {result.text_length}")
            print(f"Duration: {result.processing_duration_ms}ms")
            print(f"Cost: $0.00 (local)")
            print(f"Quality: {result.parse_quality_score}")
            print(f"Hash: {result.content_hash[:40]}...")
            print("\n=== Extracted Text (first 500 chars) ===")
            print(result.extracted_text[:500])

    except Exception as e:
        if args.json:
            logger.critical(f"Fatal error: {e}", exc_info=True)
        else:
            logger.exception(f"Fatal error: {e}")
        if args.json:
            details = {}
            if hasattr(e, "status_code"):
                details["status_code"] = e.status_code
            if hasattr(e, "file_path"):
                details["file_path"] = e.file_path
            print(
                json.dumps(
                    {
                        "error": str(e),
                        "category": getattr(e, "category", "OCR_API_ERROR"),
                        "details": details,
                    }
                )
            )
        sys.exit(1)


if __name__ == "__main__":
    main()
