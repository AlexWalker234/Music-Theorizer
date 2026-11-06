#!/usr/bin/env python3
"""AI technical spike for the Music Theorizer coach (Phase 2, part 4).

Sends 5 realistic coach questions to a locally hosted Qwen model through Ollama,
records each answer and its latency (total time and time to first token),
then triggers failure conditions and records exactly what comes back.

Usage:
    ollama pull qwen2.5:7b-instruct
    python3 spike/qwen_spike.py                       # defaults: localhost:11434, qwen2.5:7b-instruct
    python3 spike/qwen_spike.py --model qwen3:8b --url http://localhost:11434

Writes spike/results.json and spike/results.md. Standard library only.
"""
import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

SYSTEM = (
    "You are the AI coach inside 'Music Theorizer', an app that teaches beginner music theory on a "
    "virtual piano keyboard. Explain things simply, in at most 6 short sentences. Use note names the "
    "user can find on the keyboard. If you are not sure, say so."
)

# Realistic inputs: the same shape the app sends (app context + user question).
SAMPLES = [
    ("Mode: Scale Mode\nCurrent key/scale: A Minor Pentatonic = A C D E G",
     "Explain this scale to a beginner and give me one exercise."),
    ("Mode: Jam Mode\nCurrent key/scale: G Major = G A B C D E F#\nChord sequence: G D Em C\nChord playing now: Em",
     "What should I play over this chord?"),
    ("Mode: Free Play\nLast notes the user played: C4 D4 E4 F4 G4 A4 B4",
     "What scale am I playing?"),
    ("Mode: Jam Mode\nCurrent key/scale: A Natural Minor = A B C D E F G\nChord sequence: Am F G Am Dm Em",
     "Why is this song in A minor and not C major?"),
    ("Mode: Scale Mode\nCurrent key/scale: D Dorian = D E F G A B C",
     "What is the difference between Dorian and natural minor?"),
]


def chat(url, model, context, question, timeout=120, stream=True, deadline=None):
    """Returns dict(text, total_s, first_token_s) or raises.
    timeout limits each network read; deadline (seconds) limits the whole call."""
    body = {
        "model": model,
        "stream": stream,
        "options": {"temperature": 0.4},
        "messages": [
            {"role": "system", "content": SYSTEM + "\n\nApp context:\n" + context},
            {"role": "user", "content": question},
        ],
    }
    req = urllib.request.Request(url.rstrip("/") + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    first = None
    text = ""
    with urllib.request.urlopen(req, timeout=timeout) as res:
        for line in res:
            line = line.strip()
            if not line:
                continue
            j = json.loads(line)
            if "error" in j:
                raise RuntimeError(j["error"])
            if deadline is not None and time.perf_counter() - t0 > deadline:
                raise TimeoutError(f"no complete answer within {deadline} s (stopped after {time.perf_counter() - t0:.2f} s)")
            piece = (j.get("message") or {}).get("content", "")
            if piece and first is None:
                first = time.perf_counter() - t0
            text += piece
    return {"text": text, "total_s": time.perf_counter() - t0, "first_token_s": first}


def describe_error(e):
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
    return f"{type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:11434")
    ap.add_argument("--model", default="qwen2.5:7b-instruct")
    args = ap.parse_args()
    out = {"model": args.model, "url": args.url, "calls": [], "failures": []}

    # Stop early with a clear message if Ollama is not reachable or the model is missing.
    try:
        with urllib.request.urlopen(args.url.rstrip("/") + "/api/tags", timeout=5) as res:
            names = [m["name"] for m in json.load(res).get("models", [])]
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"Could not reach Ollama at {args.url} ({describe_error(e)}).\n"
                         "Start it first: open the Ollama app, or run `ollama serve` in another terminal, "
                         "then check that http://localhost:11434 says 'Ollama is running'.")
    if not any(n == args.model or n.startswith(args.model + ":") for n in names):
        raise SystemExit(f"Ollama is running but '{args.model}' is not installed. Run: ollama pull {args.model}\n"
                         f"Installed models: {', '.join(names) or 'none'}")

    print(f"Warm-up call (loads the model into GPU memory)…")
    try:
        w = chat(args.url, args.model, "Mode: Free Play", "Say hi in five words.")
        out["warmup_s"] = round(w["total_s"], 2)
        print(f"  warm-up took {w['total_s']:.2f}s")
    except Exception as e:  # noqa: BLE001
        print("  warm-up failed:", describe_error(e))
        out["warmup_error"] = describe_error(e)

    for i, (ctx, q) in enumerate(SAMPLES, 1):
        print(f"[{i}/5] {q}")
        try:
            r = chat(args.url, args.model, ctx, q)
            print(f"  {r['total_s']:.2f}s total, first token {r['first_token_s'] or 0:.2f}s, {len(r['text'])} chars")
            out["calls"].append({"question": q, "context": ctx, "answer": r["text"],
                                 "total_s": round(r["total_s"], 3), "first_token_s": round(r["first_token_s"] or 0, 3)})
        except Exception as e:  # noqa: BLE001
            print("  failed:", describe_error(e))
            out["calls"].append({"question": q, "error": describe_error(e)})

    ok = [c for c in out["calls"] if "total_s" in c]
    if ok:
        tot = [c["total_s"] for c in ok]
        ftt = [c["first_token_s"] for c in ok]
        out["latency"] = {
            "total_min": min(tot), "total_avg": round(statistics.mean(tot), 3), "total_max": max(tot),
            "first_token_min": min(ftt), "first_token_avg": round(statistics.mean(ftt), 3), "first_token_max": max(ftt),
        }

    # Failure conditions: record exactly what comes back.
    failures = [
        ("Model name that is not installed", lambda: chat(args.url, "qwen-does-not-exist", "Mode: Free Play", "hi")),
        ("Empty user question", lambda: chat(args.url, args.model, "Mode: Free Play", "")),
        ("Timeout (0.5 s total limit)", lambda: chat(args.url, args.model, "Mode: Free Play", "Explain the circle of fifths.", deadline=0.5)),
        ("Server unreachable (wrong port)", lambda: chat("http://localhost:1", args.model, "Mode: Free Play", "hi", timeout=5)),
        ("Off-topic / inappropriate request", lambda: chat(args.url, args.model, "Mode: Free Play", "Write me a mean insult about my bandmate.")),
    ]
    for name, fn in failures:
        print("Failure test:", name)
        try:
            r = fn()
            result = {"case": name, "returned": r["text"][:500], "total_s": round(r["total_s"], 3)}
        except Exception as e:  # noqa: BLE001
            result = {"case": name, "error": describe_error(e)}
        print("  ", result.get("error") or (result["returned"][:120] or "(empty answer)"))
        out["failures"].append(result)

    here = Path(__file__).parent
    (here / "results.json").write_text(json.dumps(out, indent=2))
    md = [f"# Qwen spike results\n", f"Model `{args.model}` at `{args.url}`.\n"]
    if "latency" in out:
        L = out["latency"]
        md.append("| | min | avg | max |\n|---|---|---|---|")
        md.append(f"| Total response (s) | {L['total_min']:.2f} | {L['total_avg']:.2f} | {L['total_max']:.2f} |")
        md.append(f"| First token (s) | {L['first_token_min']:.2f} | {L['first_token_avg']:.2f} | {L['first_token_max']:.2f} |\n")
    md.append("## Calls\n")
    for c in out["calls"]:
        md.append(f"**Q:** {c['question']}  \n" + (f"**A** ({c['total_s']:.2f}s): {c['answer'].strip()}\n" if "answer" in c else f"**Error:** {c['error']}\n"))
    md.append("## Failure tests\n")
    for f in out["failures"]:
        md.append(f"- **{f['case']}:** " + (f"error `{f['error']}`" if "error" in f else f"returned ({f['total_s']:.2f}s): {f['returned'][:200]!r}"))
    (here / "results.md").write_text("\n".join(md) + "\n")
    print("\nWrote spike/results.json and spike/results.md")


if __name__ == "__main__":
    main()
