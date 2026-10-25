# Trainer

Personal SwiftUI iOS app that follows your 6-page workout guide: Strength A/B (gym), Bodyweight A/B (no-gym), Minimum Effective, and Cardio. It picks today's workout from a weekly default × gym-available toggle, lets you swap per-day, logs every set with reps/weight/duration, and syncs to Supabase so Edva can query your tracking data.

## Stack
- SwiftUI + SwiftData (iOS 26, Swift 6, strict concurrency)
- Liquid Glass-styled UI (`.ultraThinMaterial` cards + animated gradient backdrop)
- Supabase (Postgres + Auth) via [supabase-swift](https://github.com/supabase/supabase-swift)
- Google Sign-In via [GoogleSignIn-iOS](https://github.com/google/GoogleSignIn-iOS) → exchanged for a Supabase session
- Face ID gate (LocalAuthentication) on cold start / resume-from-background
- HealthKit read access — Apple Watch workout start/end auto-fills cardio sessions

## Project layout
```
Trainer/
  TrainerApp.swift           — app entry, SwiftData container, Google URL handling
  Info.plist, Trainer.entitlements
  Assets.xcassets/            — 39 exercise illustration imagesets + AppIcon + AccentColor
  Catalog/WorkoutCatalog.swift — catalog of all 7 workouts + 39 exercises from the PDF
  Models/Models.swift         — SwiftData: WeeklyPlanDay, DayOverride, WorkoutSession, SetLog, AppSettings
  Services/
    AppConfig.swift           — reads Supabase URL / Google client ID from Info.plist
    AuthService.swift         — Google Sign-In → Supabase signInWithIdToken
    BiometricAuth.swift       — Face ID wrapper
    PlanScheduler.swift       — today's workout = override ?? weeklyDefault(gymAvailable)
    LastSessionLookup.swift   — prefill reps/weight from your last set
    HealthKitService.swift    — workout import
    SupabaseSync.swift        — upsert finished sessions + set logs
  Views/                      — TabView: Today · Week · History · Settings + runners and sheets
supabase/migrations/0001_initial.sql — schema + RLS + `exercise_highlights` view
```

## One-time setup

Before the app will sync or sign in, plug the following into `Trainer/Info.plist` (or a `.xcconfig` — see *Secrets*):

| Key | Source |
|---|---|
| `SupabaseURL` | Supabase project settings → API → Project URL |
| `SupabaseAnonKey` | Supabase project settings → API → anon public key |
| `GIDClientID` | Google Cloud Console → OAuth iOS client → Client ID |
| `CFBundleURLSchemes[0]` | Google Cloud Console → OAuth iOS client → **Reversed** Client ID |

The app still runs without these (for local dev/TestFlight smoke); the sign-in screen will show an error. Fill them in to enable sync.

### Supabase
1. Create a new project (e.g. `trainer-supabase`).
2. Run the migration: `supabase db push` (or paste `supabase/migrations/0001_initial.sql` into the SQL editor).
3. Auth → Providers → Google → enable, paste your Google OAuth web client ID + secret.
4. Copy Project URL and anon key into `Info.plist`.

### Google Cloud
1. Create or reuse an OAuth consent screen (external, testing mode is fine).
2. Create two OAuth clients: one **Web** (give Supabase the ID+secret), one **iOS** (bundle ID `com.example.trainer`).
3. Put the iOS client's Client ID into `GIDClientID` and its Reversed Client ID into `CFBundleURLSchemes`.

### TestFlight signing
The project uses **automatic** signing. Open `Trainer.xcodeproj`, select the *Trainer* target → Signing & Capabilities → pick your team. XcodeGen preserves any manual signing changes on re-generation if you keep them in `settings.base` of `project.yml`.

## Running
```bash
brew install xcodegen                     # once
xcodegen                                  # regenerates Trainer.xcodeproj
open Trainer.xcodeproj                   # ⌘R to run on simulator / device
```

## TestFlight build
```bash
xcodebuild -project Trainer.xcodeproj -scheme Trainer \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath build/Trainer.xcarchive archive

xcodebuild -exportArchive -archivePath build/Trainer.xcarchive \
    -exportOptionsPlist ExportOptions.plist \
    -exportPath build/export

xcrun altool --upload-app --type ios --file build/export/Trainer.ipa \
    --apiKey <asc-api-key> --apiIssuer <asc-issuer-id>
```
(Create `ExportOptions.plist` with `method=app-store`, `teamID=<your team>`, `signingStyle=automatic`.)

## How Edva reads your data

Edva queries Supabase directly. Give your Edva service role access and run e.g.:
```sql
select workout_type, count(*) as sessions, sum(coalesce(array_length(string_to_array(notes,' '),1),0))
from public.sessions
where user_id = '<your-auth-uid>' and finished_at >= now() - interval '30 days'
group by workout_type;

-- Per-exercise progression
select exercise_slug, completed_at, reps, weight_lbs
from public.set_logs
where user_id = '<your-auth-uid>' and exercise_slug = 'strength_a_goblet_squat'
order by completed_at desc
limit 20;

-- Pre-aggregated view
select * from public.exercise_highlights where user_id = '<your-auth-uid>';
```
