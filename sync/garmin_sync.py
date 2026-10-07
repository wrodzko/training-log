"""Sync daily Garmin Connect data into Firestore for the training-log page.

Writes two documents:
  garmin/daily       {updatedAt, vo2max, days: [...], weeks: [...]}
  garmin/activities  {updatedAt, items: [...]}

Garmin auth tokens are kept in Firestore at private/garmin (closed to clients by
the security rules) so token refreshes survive between runs. The first run reads
them from the GARMIN_TOKENS environment variable instead.

Usage:
  python sync/garmin_sync.py --login            # once, locally: log in (with MFA) and print tokens
  python sync/garmin_sync.py --days 90          # backfill
  python sync/garmin_sync.py                    # daily run (last 3 days)
  python sync/garmin_sync.py --dry-run --raw    # print results and save raw API responses, write nothing

Environment:
  FIREBASE_SERVICE_ACCOUNT  service account JSON (string), required unless --dry-run or --login
  GARMIN_TOKENS             token JSON printed by --login (first run, or fallback)
  GARMIN_EMAIL / GARMIN_PASSWORD  last-resort login; usually blocked from CI, MFA cannot be answered
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from garminconnect import Garmin

KEEP_DAYS = 400
ACTIVITY_DAYS = 84  # 12 weeks for the weekly volume chart
RAW_DIR = Path(__file__).parent / "raw"

RUN_TYPES = {"running", "treadmill_running", "trail_running", "track_running", "indoor_running", "virtual_run", "ultra_run"}
BIKE_TYPES = {"cycling", "road_biking", "indoor_cycling", "mountain_biking", "gravel_cycling", "virtual_ride", "e_bike_fitness", "bmx", "cyclocross"}
GYM_TYPES = {"strength_training", "fitness_equipment", "indoor_cardio", "hiit", "pilates", "yoga", "elliptical", "stair_climbing", "indoor_rowing"}


def log(msg: str) -> None:
    print(msg, flush=True)


def dig(obj, *path, default=None):
    """Safe nested lookup: dig(d, 'a', 0, 'b')."""
    for key in path:
        if obj is None:
            return default
        try:
            obj = obj[key]
        except (KeyError, IndexError, TypeError):
            return default
    return default if obj is None else obj


def num(value, digits=1):
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


class Raw:
    """Optionally keeps raw API responses on disk to debug field names."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        if enabled:
            RAW_DIR.mkdir(exist_ok=True)

    def save(self, name: str, data) -> None:
        if self.enabled:
            (RAW_DIR / f"{name}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def call(fn, *args, label=""):
    """Call a Garmin endpoint; a missing metric must not stop the sync."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - Garmin raises many types; log and continue
        log(f"  ! {label or fn.__name__}{args}: {type(exc).__name__}: {exc}")
        return None


# ---------- Firestore ----------

def firestore_client():
    import firebase_admin
    from firebase_admin import credentials, firestore

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not raw:
        sys.exit("FIREBASE_SERVICE_ACCOUNT is not set (service account JSON).")
    cred = credentials.Certificate(json.loads(raw))
    firebase_admin.initialize_app(cred)
    return firestore.client()


# ---------- Garmin auth ----------

def interactive_login() -> None:
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    garmin = Garmin(email, password, prompt_mfa=lambda: input("MFA code (from email/app): ").strip())
    garmin.login()
    tokens = garmin.client.dumps()
    log("\nLogged in as " + str(garmin.display_name))
    log("Copy the line below into the GitHub secret GARMIN_TOKENS (do not share it):\n")
    print(tokens)


def garmin_login(fs) -> Garmin:
    candidates = []
    if fs is not None:
        snap = fs.collection("private").document("garmin").get()
        if snap.exists and snap.to_dict().get("tokens"):
            candidates.append(("Firestore", snap.to_dict()["tokens"]))
    if os.environ.get("GARMIN_TOKENS"):
        candidates.append(("GARMIN_TOKENS", os.environ["GARMIN_TOKENS"].strip()))

    for source, tokens in candidates:
        try:
            garmin = Garmin()
            garmin.login(tokens)
            log(f"Garmin: logged in with tokens from {source}")
            return garmin
        except Exception as exc:  # noqa: BLE001
            log(f"Garmin: tokens from {source} failed: {type(exc).__name__}: {exc}")

    email, password = os.environ.get("GARMIN_EMAIL"), os.environ.get("GARMIN_PASSWORD")
    if email and password:
        garmin = Garmin(email, password)
        result = garmin.login()
        if result and result[0]:
            sys.exit("Garmin asks for an MFA code. Run `python sync/garmin_sync.py --login` locally and set GARMIN_TOKENS.")
        log("Garmin: logged in with email and password")
        return garmin
    sys.exit("No working Garmin credentials. Run `python sync/garmin_sync.py --login` locally and set GARMIN_TOKENS.")


def store_tokens(fs, garmin: Garmin) -> None:
    if fs is None:
        return
    fs.collection("private").document("garmin").set({
        "tokens": garmin.client.dumps(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    })


# ---------- Fetch ----------

def fetch_weights(garmin: Garmin, start: date, end: date, raw: Raw) -> dict[str, dict]:
    data = call(garmin.get_body_composition, start.isoformat(), end.isoformat())
    raw.save("body_composition", data)
    out: dict[str, dict] = {}
    for row in dig(data, "dateWeightList", default=[]):
        day = row.get("calendarDate")
        if not day:
            continue
        weight = row.get("weight")
        if weight and weight > 1000:  # Garmin returns grams
            weight = weight / 1000
        # several weigh-ins on one day: keep the earliest (list is newest first)
        out[day] = {"weight": num(weight), "fat": num(row.get("bodyFat"))}
    return out


def fetch_day(garmin: Garmin, day: date, raw: Raw) -> dict:
    d = day.isoformat()
    stats = call(garmin.get_stats, d) or {}
    sleep = call(garmin.get_sleep_data, d) or {}
    hrv = call(garmin.get_hrv_data, d) or {}
    raw.save(f"stats_{d}", stats)
    raw.save(f"sleep_{d}", sleep)
    raw.save(f"hrv_{d}", hrv)

    sleep_dto = dig(sleep, "dailySleepDTO", default={})
    hours = lambda key: num((sleep_dto.get(key) or 0) / 3600) if sleep_dto.get(key) is not None else None  # noqa: E731
    hrv_summary = dig(hrv, "hrvSummary", default={})

    return {
        "date": d,
        "rhr": stats.get("restingHeartRate"),
        "steps": stats.get("totalSteps"),
        "kcalOut": stats.get("totalKilocalories"),
        "bb": stats.get("bodyBatteryAtWakeTime") or stats.get("bodyBatteryHighestValue"),
        "sleepDeep": hours("deepSleepSeconds"),
        "sleepRem": hours("remSleepSeconds"),
        "sleepLight": hours("lightSleepSeconds"),
        "sleepScore": dig(sleep_dto, "sleepScores", "overall", "value"),
        "hrv": hrv_summary.get("lastNightAvg"),
        "hrvLow": dig(hrv_summary, "baseline", "balancedLow"),
        "hrvHigh": dig(hrv_summary, "baseline", "balancedUpper"),
        "hrvStatus": hrv_summary.get("status"),
    }


def fetch_vo2max(garmin: Garmin, day: date, raw: Raw):
    data = call(garmin.get_max_metrics, day.isoformat())
    raw.save("max_metrics", data)
    rows = data if isinstance(data, list) else [data] if data else []
    for row in rows:
        value = dig(row, "generic", "vo2MaxPreciseValue") or dig(row, "generic", "vo2MaxValue")
        if value:
            return num(value)
    return None


def activity_kind(type_key: str) -> str:
    if type_key in RUN_TYPES or "run" in type_key:
        return "run"
    if type_key in BIKE_TYPES or "cycl" in type_key or "bik" in type_key:
        return "bike"
    if type_key in GYM_TYPES or "strength" in type_key:
        return "gym"
    return "other"


def fmt_duration(seconds) -> str:
    s = int(round(seconds or 0))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def fetch_activities(garmin: Garmin, start: date, end: date, raw: Raw) -> list[dict]:
    data = call(garmin.get_activities_by_date, start.isoformat(), end.isoformat()) or []
    raw.save("activities", data)
    items = []
    for a in data:
        kind = activity_kind(dig(a, "activityType", "typeKey", default=""))
        dist_km = (a.get("distance") or 0) / 1000
        duration = a.get("duration") or a.get("movingDuration") or 0
        pace = None
        if kind == "run" and dist_km > 0.2:
            per_km = duration / dist_km
            pace = f"{int(per_km // 60)}:{int(per_km % 60):02d} /km"
        elif kind == "bike" and duration > 0 and dist_km > 0:
            pace = f"{dist_km / (duration / 3600):.1f} km/h".replace(".", ",")
        items.append({
            "date": (a.get("startTimeLocal") or "")[:10],
            "type": kind,
            "title": a.get("activityName") or kind,
            "distanceKm": round(dist_km, 2) if dist_km > 0.05 else None,
            "durationSec": int(duration),
            "duration": fmt_duration(duration),
            "pace": pace,
            "avgHr": int(a["averageHR"]) if a.get("averageHR") else None,
            "maxHr": int(a["maxHR"]) if a.get("maxHR") else None,
            "te": num(a.get("aerobicTrainingEffect")),
            "kcal": int(a["calories"]) if a.get("calories") else None,
        })
    items.sort(key=lambda x: x["date"], reverse=True)
    return items


def weekly_volume(items: list[dict], today: date) -> list[dict]:
    monday = today - timedelta(days=today.weekday())
    weeks = []
    for i in range(11, -1, -1):
        start = monday - timedelta(weeks=i)
        end = start + timedelta(days=6)
        row = {"start": start.isoformat(), "run": 0, "bike": 0, "gym": 0}
        for it in items:
            if start.isoformat() <= it["date"] <= end.isoformat() and it["type"] in row:
                row[it["type"]] += round(it["durationSec"] / 60)
        weeks.append(row)
    return weeks


# ---------- Main ----------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--login", action="store_true", help="interactive login; prints tokens for GARMIN_TOKENS")
    ap.add_argument("--days", type=int, default=3, help="how many recent days to (re)fetch, default 3")
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing to Firestore")
    ap.add_argument("--raw", action="store_true", help="save raw Garmin responses to sync/raw/ (gitignored)")
    args = ap.parse_args()

    if args.login:
        interactive_login()
        return

    fs = None if args.dry_run else firestore_client()
    raw = Raw(args.raw)
    garmin = garmin_login(fs)
    store_tokens(fs, garmin)  # save right away: a login may have refreshed them

    today = date.today()
    start = today - timedelta(days=max(1, args.days) - 1)
    log(f"Fetching {start} … {today}")

    weights = fetch_weights(garmin, start, today, raw)
    fresh: dict[str, dict] = {}
    day = start
    while day <= today:
        row = fetch_day(garmin, day, raw)
        row.update(weights.get(day.isoformat(), {}))
        fresh[row["date"]] = {k: v for k, v in row.items() if v is not None}
        log(f"  {row['date']}: " + ", ".join(f"{k}={v}" for k, v in fresh[row['date']].items() if k != "date"))
        day += timedelta(days=1)
        time.sleep(0.3)

    vo2max = fetch_vo2max(garmin, today, raw)
    items = fetch_activities(garmin, today - timedelta(days=ACTIVITY_DAYS), today, raw)
    weeks = weekly_volume(items, today)
    log(f"Activities: {len(items)} in the last {ACTIVITY_DAYS} days, VO2max: {vo2max}")

    if args.dry_run:
        log("Dry run: nothing written.")
        return

    daily_ref = fs.collection("garmin").document("daily")
    existing = daily_ref.get().to_dict() or {}
    by_date = {d["date"]: d for d in existing.get("days", []) if d.get("date")}
    for d, row in fresh.items():
        by_date[d] = {**by_date.get(d, {}), **row}
    days = sorted(by_date.values(), key=lambda x: x["date"])[-KEEP_DAYS:]

    now = datetime.now(timezone.utc).isoformat()
    daily_ref.set({
        "updatedAt": now,
        "vo2max": vo2max if vo2max is not None else existing.get("vo2max"),
        "days": days,
        "weeks": weeks,
    })
    fs.collection("garmin").document("activities").set({"updatedAt": now, "items": items[:30]})
    store_tokens(fs, garmin)
    log(f"Saved {len(fresh)} days ({len(days)} kept) and {min(len(items), 30)} activities.")


if __name__ == "__main__":
    main()
