# training-log

Shared dashboard for athlete and coach: training plan, food log and Garmin data.
The UI is in Polish.

- **Page:** static site on GitHub Pages (`index.html`, `css/`, `js/`).
- **Data and sign-in:** Firebase (Firestore + Google sign-in). Only emails listed in `config/access` can open it.
- **Garmin sync:** a GitHub Actions job runs `sync/garmin_sync.py` daily and writes to Firestore.

Personal data never goes into this repository. It lives in Firestore.

```
GitHub Pages ──▶ index.html ──▶ Firebase Auth (Google) ──▶ Firestore
GitHub Actions (daily) ──▶ sync/garmin_sync.py ──▶ Garmin Connect ──▶ Firestore
```

## Setup

### 1. Firebase project

Use a personal Google account.

1. [console.firebase.google.com](https://console.firebase.google.com) → **Create project**. Google Analytics is not needed.
2. **Build → Firestore Database → Create database** → production mode, location `europe-central2` (Warsaw).
3. **Firestore → Rules** → paste the contents of [`firestore.rules`](firestore.rules) → **Publish**.
4. **Firestore → Data → Start collection** `config`, document ID `access`, fields:

   | field | type | value |
   |---|---|---|
   | `athlete` | string | athlete's Google email, lowercase |
   | `coaches` | array of strings | coach's Google email(s), lowercase |
   | `athleteName` | string | name shown in the header |

5. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
6. **Authentication → Settings → Authorized domains → Add domain:** `wrodzko.github.io`.
7. **Project settings → General → Your apps → Web (`</>`)** → register the app → copy the `firebaseConfig` values into [`js/config.js`](js/config.js). These values are public by design.

### 2. GitHub Pages

**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`.**
The site will be at `https://wrodzko.github.io/training-log/`.

### 3. Garmin sync

Garmin has no official personal API. The sync uses the unofficial
[`garminconnect`](https://github.com/cyberjunky/python-garminconnect) library, which can break when Garmin changes its login.

1. **Service account:** Firebase → Project settings → Service accounts → **Generate new private key**. Keep the file out of this folder (it is gitignored, but don't rely on that).
2. **Garmin tokens:** log in once on your computer. This handles MFA too:

   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r sync/requirements.txt
   .venv/bin/python sync/garmin_sync.py --login
   ```

   It prints one line of JSON: your Garmin tokens.
3. **GitHub → Settings → Secrets and variables → Actions → New repository secret:**

   | secret | value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | full contents of the service account JSON file |
   | `GARMIN_TOKENS` | the JSON line from step 2 |

   Optional fallback: `GARMIN_EMAIL` and `GARMIN_PASSWORD`. Garmin often blocks password logins from cloud servers, so tokens are the main path.
4. **Actions → Garmin sync → Run workflow** with `days = 90` for the first backfill. After that it runs every morning.

After each run the job stores refreshed Garmin tokens in Firestore (`private/garmin`, closed to the web app), so the `GARMIN_TOKENS` secret is only needed for the first run or if those tokens stop working.

To check what Garmin returns without writing anything:

```bash
.venv/bin/python sync/garmin_sync.py --dry-run --raw --days 2   # raw responses go to sync/raw/ (gitignored)
```

## Data model (Firestore)

| path | written by | content |
|---|---|---|
| `config/access` | Firebase console | who can open the page |
| `garmin/daily` | sync job | `days[]` (weight, fat, sleep, HRV, resting HR, Body Battery, steps, kcal), `weeks[]`, `vo2max` |
| `garmin/activities` | sync job | last 30 activities |
| `workouts/{id}` | page | date, type, title, target, notes, `exercises[].sets[]` (plan: `reps`, `kg`; done: `aReps`, `aKg`, `done`), `result`, `rpe` |
| `food/{YYYY-MM-DD}` | page | `meals[].items[]` (`name`, `g`, `kcal`, `p`, `f`, `c`), `water`, `note`, `coachNote` |
| `settings/targets` | page | daily nutrition targets, weight and body-fat goals |
| `comments/{id}` | page | `text`, `authorUid`, `authorName`, `role`, `at` |
| `private/garmin` | sync job | Garmin tokens (no client access) |

## Local preview

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. `localhost` is an authorized domain in Firebase by default.

## Notes

- **Free tier:** Firebase Spark and GitHub Actions cover this easily for two users.
- **Scheduled jobs pause:** GitHub disables scheduled workflows in public repos after 60 days without repository activity. It sends an email first, and one click in Actions re-enables the job.
- **Sync failures:** a failed run shows in Actions, and GitHub emails you. The page also shows a warning when Garmin data is more than two days old.
