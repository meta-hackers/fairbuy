"""One-off, resumable Cloudflare or Meta generation. Requires Pillow; never runs in the app.

Cloudflare needs CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN; Meta needs MODEL_API_KEY.
Existing assets are skipped; --limit N bounds new generations for a preview batch.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
from threading import Lock
import time
import urllib.error
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STYLE = ("Minimal flat vector-style editorial illustration of {subject}. One isolated object, "
         "centered, fully visible with generous empty margins. Muted sage green and dark forest "
         "green outlines, warm off-white background, subtle soft ground shadow. Simple clean "
         "geometric shapes, elegant consistent shopping app icon artwork. Not a photograph, "
         "no people, no text, no lettering, no logos, no brand marks, no border.")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--limit", type=int, default=150)
parser.add_argument("--provider", choices=["cloudflare", "meta"], default="cloudflare")
parser.add_argument("--workers", type=int, choices=range(1, 5), default=1, help="Bounded generation concurrency (1-4)")
parser.add_argument("--only", help="Comma-separated slugs to generate")
parser.add_argument("--replace", action="store_true", help="Deliberately regenerate selected existing assets; requires --only")
args = parser.parse_args()
if args.replace and not args.only:
    parser.error("--replace requires --only to avoid replacing the entire catalog")
if args.provider == "meta":
    model = "muse-image-1.0"
    endpoint = "https://api.meta.ai/v1/images/generations"
    token = os.environ["MODEL_API_KEY"]
else:
    model = "@cf/black-forest-labs/flux-1-schnell"
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
    token = os.environ["CLOUDFLARE_API_TOKEN"]
entries = json.loads((ROOT / "frontend/src/product-illustrations.json").read_text())
if args.only:
    selected = set(args.only.split(","))
    if selected - {entry[0] for entry in entries}:
        parser.error("Unknown illustration slug")
    entries = [entry for entry in entries if entry[0] in selected]
output = ROOT / "frontend/public/illustrations"
output.mkdir(parents=True, exist_ok=True)
metadata_path = output / "provenance.json"
metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
if args.limit < 0:
    parser.error("--limit must be nonnegative")
pending = [entry for entry in entries if args.replace or not (output / f"{entry[0]}.webp").exists()][:args.limit]


def generate(entry):
    slug, subject, _ = entry
    dest = output / f"{slug}.webp"
    prompt = STYLE.format(subject=subject)
    body = {"prompt": prompt, "steps": 4} if args.provider == "cloudflare" else {
        "model": model, "prompt": prompt, "n": 1, "size": "1024x1024",
        "response_format": "b64_json", "output_format": "webp", "reasoning_strength": "low",
        "tool_enablement": {"enable_image_search": False, "enable_web_search": False, "enable_shell": False},
    }
    for attempt in range(3):
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            encoded = (payload.get("data") or [{}])[0].get("b64_json") if args.provider == "meta" else (
                payload.get("result", {}).get("image") if payload.get("success") else None)
            if not encoded:
                raise RuntimeError("Image generation returned no image")
            image = Image.open(io.BytesIO(base64.b64decode(encoded)))
            image.convert("RGB").resize((384, 384), Image.Resampling.LANCZOS).save(dest, "WEBP", quality=80)
            break
        except urllib.error.HTTPError as error:
            print(f"{slug}: provider HTTP {error.code}, attempt {attempt + 1}", flush=True)
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise SystemExit("Generation stopped; existing assets retained. Check provider allowance/access.")
            time.sleep(10 * (attempt + 1))
    record = {"provider": args.provider, "model": model, "prompt": prompt,
              "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "sha256": hashlib.sha256(dest.read_bytes()).hexdigest()}
    # One writer serializes provenance updates. Each completed worker persists
    # its result before accepting another item, including on interrupted batches.
    with metadata_lock:
        metadata[slug] = record
        temporary = metadata_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(metadata, indent=2) + "\n")
        temporary.replace(metadata_path)
        print(f"Generated {slug} ({args.provider})", flush=True)
    time.sleep(1)
    return slug


metadata_lock = Lock()
with ThreadPoolExecutor(max_workers=args.workers) as pool:
    # Submit only one wave at a time, so failure does not launch the remaining
    # catalog or incur unbounded additional calls while a worker is failing.
    for offset in range(0, len(pending), args.workers):
        futures = [pool.submit(generate, entry) for entry in pending[offset:offset + args.workers]]
        for future in futures:
            future.result()
print(f"Done: {len(list(output.glob('*.webp')))} illustrations available", flush=True)
