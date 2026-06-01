#!/usr/bin/env python3
"""MLX Whisper wrapper — drop-in replacement for whisper-cli (whisper.cpp).

Shebang line is rewritten by ClaudeClaw at install time to point at the
agent's local mlx-env Python interpreter (see src/engines/mlx.ts).

CLI mostly mirrors whisper-cli (whisper.cpp) so callers can swap the binary
without code changes. Two MLX-specific extensions:

  --model NAME            Short model name; mapped to mlx-community HF repo
                          (tiny / base / small / medium / large-v3 /
                          large-v3-turbo). Falls back to large-v3-turbo.
  --prompt TEXT           initial_prompt for biasing.
  --prompt-file PATH      Read initial_prompt from file (avoids huge argv).
"""

import argparse
import os
import sys

MODEL_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}
DEFAULT_MODEL = "large-v3-turbo"


def resolve_repo(model: str | None) -> str:
    if not model:
        return MODEL_REPOS[DEFAULT_MODEL]
    if model in MODEL_REPOS:
        return MODEL_REPOS[model]
    if "/" in model:
        return model  # already a HF repo path
    return MODEL_REPOS.get(model, MODEL_REPOS[DEFAULT_MODEL])


def read_prompt(args) -> str | None:
    if args.prompt:
        return args.prompt
    if args.prompt_file:
        try:
            with open(args.prompt_file, "r", encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError as exc:
            print(f"warning: failed to read prompt-file {args.prompt_file}: {exc}",
                  file=sys.stderr)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-m", "--model", default=None)
    parser.add_argument("-otxt", action="store_true")
    parser.add_argument("-of", "--output-file", default=None)
    parser.add_argument("-np", action="store_true")
    parser.add_argument("-nt", action="store_true")
    parser.add_argument("-l", "--language", default=None)
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--prompt-file", dest="prompt_file", default=None)
    parser.add_argument("audio_file", nargs="?", default=None)

    args, remaining = parser.parse_known_args()

    audio_file = args.audio_file
    if not audio_file and remaining:
        audio_file = remaining[-1]

    if not audio_file or not os.path.exists(audio_file):
        print(f"Error: audio file not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    import mlx_whisper

    repo = resolve_repo(args.model)
    initial_prompt = read_prompt(args)

    kwargs = {
        "path_or_hf_repo": repo,
        "language": args.language,
    }
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    result = mlx_whisper.transcribe(audio_file, **kwargs)

    text = result.get("text", "").strip()

    if args.output_file:
        output_path = args.output_file + ".txt"
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text)

    print(text)


if __name__ == "__main__":
    main()
