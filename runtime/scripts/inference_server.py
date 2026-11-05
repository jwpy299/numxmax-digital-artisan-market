#!/usr/bin/env python3
"""Local S4 inference for real base/LoRA artifacts, never a remote-API fallback."""
import argparse
import json
import os
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from generation_utils import generate_new_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--adapter", default="")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--version", default="")
    args = parser.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(args.base)
    if args.adapter:
        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    version = args.version or (os.path.basename(args.adapter) if args.adapter else "base")

    def generate(text: str) -> tuple[str, str]:
        answer, finish_reason = generate_new_text(model, tokenizer, text, torch.no_grad, max_new_tokens=192)
        if not answer:
            raise RuntimeError("empty_generation")
        return answer, finish_reason

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/healthz":
                return self.respond({"ok": True, "model_loaded": True, "source": "s4-local", "adapter": bool(args.adapter), "version": version, "pid": os.getpid()})
            return self.respond({"ok": False, "error": "not_found"}, 404)

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                return self.respond({"ok": False, "error": "not_found"}, 404)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1_000_000:
                    return self.respond({"ok": False, "error": "invalid_content_length"}, 413)
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                messages = body.get("messages", [])
                text = next((str(m.get("content", "")) for m in reversed(messages) if m.get("role") == "user"), "")
                if not text.strip():
                    return self.respond({"ok": False, "error": "empty_user_message"}, 400)
                answer, finish_reason = generate(text)
                return self.respond({
                    "id": f"s4-local-{uuid.uuid4()}",
                    "object": "chat.completion",
                    "model": "s4-lora" if args.adapter else "s4-base",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": finish_reason}],
                })
            except Exception as exc:
                return self.respond({"ok": False, "error": type(exc).__name__}, 500)

        def respond(self, payload, status=200):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.request_queue_size = 8
    print(f"INFERENCE_READY port={args.port} version={version} pid={os.getpid()}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
