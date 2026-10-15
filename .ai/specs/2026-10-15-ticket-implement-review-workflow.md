# Ticket → Implementer (Cursor Auto) → Verify → Reviewer (Opus) → Verify → Review Gate

Status: **propozycja / analiza** (2026-10-15). Pilot: AltflowMetrics (`baseBranch: dev`).
Nic z tego jeszcze nie jest wdrożone. Poziomy STANDARD / HIGH RISK — poza zakresem.

## 1. Jak Cezar dziś definiuje workflow

- Pliki YAML w `<repo>/.ai/cezar/workflows/*.yaml`, plik repo o tej samej nazwie wygrywa z
  wbudowanym (`workflows/load.ts`). Dwa formaty:
  - **v1** — `steps:` (krok agentowy `prompt`/`skill` XOR krok `command`), `onFail: {retry, max, retryOn}`.
  - **v2** — `version: 2`, `nodes` + `edges` (spec `2026-09-30-workflow-node-editor`). Węzły:
    `agent`, `check`, `loop`, `if`, `gate.human`, `ask-user`, `fork/join`, `git.*`, `github.*`, `end`.
- **Jeden silnik**: v1 jest kompilowany do grafu (`compileV1`) i chodzi tym samym `executeGraph`
  (`workflows/run.ts`). Wbudowany `implement-review-pr` (`workflows/templates.ts`) to już prawie
  nasz kształt: implement → `npm test` → loop fix → AI review z werdyktami → gate.human → draft PR.

## 2. Per-step runner i model

- Węzeł/krok `agent` ma `runner` (`claude | codex | opencode | cursor | pi | junie | copilot`)
  i `model` (string przekazywany 1:1). Fallback: backend/model zadania.
- Cursor: `agent -p --force --trust --output-format stream-json --model <model>` → `model: auto` działa.
- Claude: `claude --print … --model <model> --permission-mode dontAsk`. Dla Opus 5.5:
  `model: claude-opus-5-5` (alias `opus` też przejdzie, ale jawne id jest stabilniejsze w metrykach).
- **Brak per-step `effort` / reasoning budgetu** — nie da się go ustawić z YAML.

## 3. Przekazywanie kontekstu między krokami

- `{{task}}` — ten sam tekst zadania w każdym kroku agentowym. Przy starcie z zakładki YouTrack
  (`web/src/lib/tracker-task.ts`) to snapshot: ID, tytuł, URL, status, autor, tagi, **opis**.
  Komentarzy, załączników, custom fields i powiązań **nie ma** (snapshot mówi to wprost).
- `{{nodes.<id>.<field>}}` (tylko v2-grafy, ale v1 też przechodzi przez renderer):
  - agent: `summary` (ostatnie 4 000 znaków ostatniej tury), `verdict`, `costUsd`;
  - check: `output` (stdout+stderr), `exitCode`;
  - loop: `iteration`, `max`.
- Każdy krok agentowy to **nowa sesja** w tym samym worktree; wspólny jest system plików i plik
  handoff (`CEZ_HANDOFF_FILE`). `session: {continue: <node>}` wznawia sesję innego węzła — ale tylko
  dla `claude | codex | pi`. **Cursor nie jest wznawialny** (`RESUMABLE_BACKENDS`) — węzeł z
  `continue` na Cursorze startuje świeżą sesję z notą.
- Checki dostają `process.env` serwera, **bez** `CEZ_TASK_ID`, bez bazy diffu, bez treści zadania;
  w komendzie checka renderowane są tylko `{{nodes.*}}`, nie `{{task}}` (słusznie — to byłby shell injection).

## 4. Retry po nieudanym checku

- v1: `onFail.retry: <wcześniejszy krok>`, `max` (domyślnie 2), `retryOn: [kody]`.
  v2: `check.fail → loop(max) → repeat → agent`, `exhausted → end failed`. Licznik pętli nie resetuje się w runie.
- Następny krok agentowy po nieudanym checku **automatycznie** dostaje dopisane:
  „A verification command failed after the previous attempt. Fix the cause. Failing output: …”.
  (Wbudowane szablony dodatkowo wklejają `{{nodes.tests.output}}` — to dubluje output.)
- **Dwie słabości checków, istotne dla `agent-verify.sh`:**
  1. Output jest ucinany do 20 000 znaków **od początku** (`CHECK_OUTPUT_CAP`) — ogon, gdzie
     Django/pytest/tsc drukują podsumowanie błędów, ginie przy głośnym logu.
  2. Check **nie ma timeoutu**. Zawieszony test (np. czekający na Postgresa) trzyma run i slot
     `maxParallel` w nieskończoność.

## 5. Diff względem brancha bazowego

- Worktree `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` od `config.baseBranch` (AltflowMetrics: `dev`).
- Kanoniczny diff zadania: `resolveTaskDiffBase` (`git-diff-base.ts`) — merge-base ze świeższym z
  `<base>` / `origin/<base>`, plus `git add -N .`, żeby nowe nieśledzone pliki były widoczne.
- **Agent tej bazy nie dostaje** — ani w env, ani w tokenie promptu. Reviewer musi ją policzyć sam
  (`git merge-base origin/dev HEAD`) — dla jednego repo pilotażowego to akceptowalne.
- Cezar sam commituje: `autosaveCommit` przy końcu tury kontynuacji, przed PR i „run finalize”.

## 6. Review Gate

- `settleSuccess`: udany run z niepustym diffem parkuje w `review` (Changes, feedback, draft PR, finish)
  **tylko gdy gate jest włączony** — `config.reviewGate` (Settings) albo `CEZ_REVIEW_GATE=1`.
  **Domyślnie WYŁĄCZONY** (#489), i zawsze pomijany dla runów `autonomous`.
- Nieudany run (`end failed`, wyczerpana pętla) **nigdy** nie wchodzi w review.
- Niezależnie od tego graf ma `gate.human` (approve/reject) i `github.draft-pr`.

→ Dla pilota trzeba włączyć `reviewGate: true` w AltflowMetrics i odpalać zadania nie-autonomicznie.

## 7. Jak dać Reviewerowi ticket, diff i wyniki testów

| Co | MVP (sama konfiguracja) | Lepiej (po małych zmianach w Cezarze) |
| --- | --- | --- |
| Ticket | `{{task}}` (snapshot z opisem, start z zakładki YouTrack) + Reviewer sam dociąga komentarze i powiązania przez MCP `youtrack-altflow` | deterministyczny check `scripts/agent-ticket.sh` pobiera ticket+komentarze+linki przez REST **raz**, do pliku; `{{nodes.ticket.output}}` trafia identycznie do Implementera i Reviewera |
| Diff | Reviewer sam: `git add -N . && git diff $(git merge-base origin/dev HEAD)`; `agent-verify.sh` drukuje `--stat` | `CEZ_BASE_REF` (wynik `resolveTaskDiffBase`) w env agentów i checków |
| Testy | `{{nodes.verify.output}}` — podsumowanie z `agent-verify.sh` | bez zmian |
| Twierdzenia Implementera | `{{nodes.implement.summary}}`, jawnie oznaczone jako „do weryfikacji, nie prawda” | bez zmian |

Uwaga na MCP Reviewera: Claude działa z `--permission-mode dontAsk` — narzędzie spoza allowlisty
jest odrzucane. W AltflowMetrics `.claude/settings.local.json` (gitignored) ma
`enabledMcpjsonServers` i `mcp__youtrack-altflow__*`, a Cezar seeduje ten plik do worktree
(`agent-config/seed.ts`) — więc **powinno** działać bez zmian. Do potwierdzenia w pierwszym
przebiegu (MCP po HTTP z OAuth w trybie `-p`). Cursor: istniejący krok `agent mcp enable youtrack`
(zgody MCP w Cursorze są per katalog) — zostaje.

## 8. Czy da się to zrobić samą konfiguracją?

**Tak — MVP da się uruchomić bez zmian w kodzie Cezara.** Graf v2 ma wszystko: per-węzeł runner/model,
dwa niezależne checki z pętlami, werdykty Reviewera, `gate.human`, review gate.

Ale są rzeczy, których obecny Cezar nie robi albo robi źle — i część założeń trzeba skorygować:

1. **Reguła `.cursor/rules/youtrack-ticket.mdc` (`alwaysApply: true`) i `CLAUDE.md` w AltflowMetrics
   każą agentowi: utworzyć branch `feature/<ID>`, zmienić status ticketu, commit, push, PR, `FIXED`.**
   W tym pipeline Implementer otworzyłby PR **przed** Reviewerem i na innym branchu niż `cez/<id8>`.
   To największe ryzyko pilota. Rozwiązanie: prompt kroku jawnie uruchamia „tryb autonomiczny zewnętrzny”
   (wyjątek przewidziany w `CLAUDE.md`) i zakazuje git checkout/commit/push/PR/zmian statusu; a docelowo
   reguła dostaje sekcję „pod Cezarem nie rób kroków 2, 7–9”.
2. **„Pytest”** — AltflowMetrics ma testy Django (`tests_*.py`, `TestCase`), bez konfiguracji pytest-django.
   Właściwa komenda to `manage.py test`.
3. **Testy w worktree nie zadziałają „z pudełka”**: brak `.venv`, `node_modules`, `.envs/.env`
   (wszystko gitignored), Postgres jest w dockerze (`localhost:5456`), a **dwa równoległe runy zderzą
   się na tej samej bazie `test_app`** (`--noinput` skasuje bazę sąsiada). To praca w AltflowMetrics,
   nie w Cezarze — patrz §10.
4. **`agent-verify.sh` musi być zielony na czystym `dev`.** Inaczej każdy run pali retry Implementera
   na błędach, których nie spowodował. To warunek wejścia pilota.
5. **Koszt Implementera**: Cursor raportuje tokeny, nie USD — koszt z dashboardu Cursora. Claude
   raportuje `costUsd` per krok, więc koszt review jest mierzalny wprost.
6. **Retry Implementera to świeża sesja Cursora** (brak resume) — dostaje ticket + output błędu, ale nie
   swoją historię rozumowania. Na MVP wystarczy; `--resume` w `cursor-agent-runner.ts` to przyszłe ulepszenie.
7. **„Reviewer sam naprawia, bez ping-ponga”** — popieram. Ale potrzebne jest wyjście „blocked”:
   gdy ticket jest sprzeczny albo defekt wymaga decyzji produktowej, Reviewer nie powinien zgadywać.
   W grafie: werdykt `blocked` → `gate.human`.
8. Brak budżetu per krok w YAML (jest budżet runu i `budgetUsd` dla fork/dispatch). Na pilota: obserwacja,
   bez limitu; Reviewer i tak nie ma narzędzia `Task` (sub-agentów) w domyślnej allowliście.

## 9. Minimalne zmiany w Cezarze (opcjonalne dla MVP, rekomendowane przed szerszym użyciem)

Każda to osobny, mały commit z testem regresji (AGENTS.md: najpierw red bez fixa).

| # | Zmiana | Dlaczego | Rozmiar |
| --- | --- | --- | --- |
| C1 | Checki dostają env `CEZ_TASK_ID`, `CEZ_BASE_REF` (z `resolveTaskDiffBase`), `CEZ_TASK_FILE` (plik z tekstem zadania); agenci — `CEZ_BASE_REF` | deterministyczne pobranie ticketu i poprawna baza diffu w skrypcie, bez wstrzykiwania `{{task}}` do shella | S |
| C2 | `CHECK_OUTPUT_CAP`: zachować **ogon** (albo head+tail), nie początek | podsumowanie błędów jest na końcu logu | XS |
| C3 | Opcjonalny `timeoutMs` na węźle `check` (bez domyślnej wartości → zero zmiany zachowania istniejących workflow) | wyjście z wiszącego checka; dziś to stan bez wyjścia | S |
| C4 | Redakcja `YOUTRACK_TOKEN` w `resolveAgentEnv` (`run.ts:1347` redaguje tylko Jira i Linear) | bug: token YouTrack z automatyzacji nie jest maskowany w transkryptach | XS, niezależny od pilota |

Do MVP **nie są potrzebne**: nowe typy węzłów, klasyfikacja ryzyka, nowy runner.

## 10. Wymagania po stronie AltflowMetrics

`scripts/agent-verify.sh` (wykonywalny, commitowany), kontrakt:

- exit `0` = zielono, `1` = kod/testy są złe (retry ma sens), `2` = środowisko (brak DB, venv, tokenu
  npm) — **nie** retry'ujemy agenta na infrastrukturze (`retryOn: [1]`).
- stdout: jedna linia `PASS/FAIL <check> (<czas>)` na check, dla FAIL ostatnie ~150 linii logu;
  pełne logi do `.ai/verify/` (dopisane do `.git/info/exclude`). Na końcu `git diff --stat` vs merge-base.
  Całość < 20 000 znaków (dziś ucinany jest koniec — patrz C2).
- własny timeout per check (macOS nie ma `timeout` — `perl -e 'alarm …; exec …'`).
- środowisko: venv z głównego checkoutu (`$(git rev-parse --path-format=absolute --git-common-dir)/..`),
  `pnpm install --frozen-lockfile` w worktree (store pnpm, hardlinki), `DATABASE_URL` na
  `localhost:5456`, unikalna nazwa bazy testowej per worktree (wymaga w `settings/base.py`
  `DATABASES["default"]["TEST"] = {"NAME": env("DJANGO_TEST_DB_NAME", default=None)}`).
- checki: `ruff check` · `manage.py check` · `manage.py makemigrations --check --dry-run` ·
  `manage.py test --noinput` · `pnpm --filter web typecheck` · `lint` · `test` · `build`.
  Bramkowanie po zmienionych ścieżkach (`services/api/**` vs `apps/web/**`) jest decyzją repo, nie Cezara;
  `AGENT_VERIFY_ALL=1` wymusza całość. Skrypt jest uruchamiany 2× na run (+ retry), więc czas ma znaczenie.

Plus: `.ai/cezar/config.json` → `"reviewGate": true`; sekcja w `youtrack-ticket.mdc` o trybie pod Cezarem.

## 11. Proponowany pierwszy workflow

`AltflowMetrics/.ai/cezar/workflows/ticket-implement-review.yaml`:

```yaml
version: 2
name: ticket-implement-review
description: Cursor Auto implementuje ticket YouTrack, agent-verify.sh, Opus 5.5 recenzuje i poprawia, agent-verify.sh, review gate.
nodes:
  - { id: start, type: start }

  - id: approve-mcp
    type: check
    name: Zatwierdź YouTrack MCP (Cursor)
    command: agent mcp enable youtrack

  - id: implement
    type: agent
    name: Implementer (Cursor Auto)
    runner: cursor
    model: auto
    prompt: |
      Pracujesz w autonomicznym trybie zewnętrznym Cezara (plan uznany za zaakceptowany).
      Jesteś IMPLEMENTEREM. Po Tobie automatyczne checki i niezależny reviewer.

      Ticket (snapshot):
      {{task}}

      1. Pobierz ticket przez MCP YouTrack: pełny opis, kryteria akceptacji, decyzje PM, komentarze,
         istotne powiązane tickety. Decyzje PM mają pierwszeństwo przed opisem.
      2. Przeanalizuj istniejący kod i konwencje. Zaimplementuj DOKŁADNIE wymaganie — tylko zmiany
         konieczne; bez refactorów i „ulepszeń przy okazji”.
      3. Dodaj lub zmodyfikuj testy, które weryfikują wymaganie z ticketu, a nie tylko implementację.
      4. Uruchom `scripts/agent-verify.sh` i doprowadź do zielonego.
      5. Przejrzyj własny diff (`git add -N . && git diff $(git merge-base origin/dev HEAD)`).

      W TYM workflow NIE wykonuj kroków 2 i 7–9 z reguły youtrack-ticket: nie przełączaj brancha,
      nie commituj, nie pushuj, nie twórz PR, nie zmieniaj statusu ani nie komentuj ticketu.
      Cezar zarządza branchem i PR-em.

      Zakończ raportem: co zmieniłeś i dlaczego, które kryterium akceptacji pokrywa który test,
      czego NIE zrobiłeś i jakie założenia przyjąłeś.

  - id: verify
    type: check
    name: agent-verify.sh
    command: scripts/agent-verify.sh
    retryOn: [1]
  - { id: impl-retry, type: loop, name: Poprawki implementera, max: 2 }
  - id: impl-fix
    type: agent
    name: Implementer — poprawka checków
    runner: cursor
    model: auto
    prompt: |
      Autonomiczny tryb zewnętrzny Cezara. `scripts/agent-verify.sh` nie przeszedł
      (runda {{nodes.impl-retry.iteration}}/{{nodes.impl-retry.max}}); output poniżej.
      Ticket: {{task}}
      Napraw przyczynę, nie testy. Bez commitów, pushy, PR i zmian w YouTrack.

  - id: review
    type: agent
    name: Reviewer (Opus 5.5)
    runner: claude
    model: claude-opus-5-5
    verdicts: [clean, fixed, blocked]
    prompt: |
      Jesteś niezależnym senior developerem i code reviewerem. Nie zakładaj, że implementacja
      jest poprawna. Najważniejsze pytanie: czy kod realizuje TO wymaganie, które opisuje ticket?

      Ticket (snapshot): {{task}}
      Pobierz przez MCP youtrack-altflow pełny ticket: kryteria akceptacji, decyzje PM, komentarze,
      powiązania. Ticket jest specyfikacją; raport implementera nie jest.

      Diff zadania: `git add -N . && git diff $(git merge-base origin/dev HEAD)`.
      Możesz czytać całe repo.

      Wynik agent-verify.sh po implementacji:
      {{nodes.verify.output}}

      Raport implementera (twierdzenia DO WERYFIKACJI):
      {{nodes.implement.summary}}

      Sprawdź: spełnienie i kompletność wymagań, błędne założenia, regresje, edge case'y,
      bezpieczeństwo, auth/permissions, walidację, transakcje i race conditions, N+1, migracje,
      zgodność API i frontend/backend, backward compatibility, testy brakujące, słabe lub
      przechodzące bez weryfikowania wymagania.

      Realny defekt napraw sam, minimalnie, z testem, który bez poprawki by nie przeszedł.
      NIE: refactory niezwiązane z ticketem, zmiany stylu wg preferencji, przebudowa architektury.
      Nie commituj, nie pushuj, nie twórz PR, nie zmieniaj ticketu. Po poprawkach uruchom
      `scripts/agent-verify.sh`.

      Raport: lista znalezisk (plik:linia, waga, czy poprawione), lista rzeczy sprawdzonych bez
      zastrzeżeń, ocena testów. Werdykt: `clean` — nic do poprawy; `fixed` — poprawiłeś defekty;
      `blocked` — wymaga decyzji człowieka (sprzeczny ticket, decyzja produktowa, ryzyko którego
      nie da się bezpiecznie naprawić).

  - id: blocked-gate
    type: gate.human
    name: Reviewer prosi o decyzję
    message: "Reviewer zatrzymał pipeline: {{nodes.review.summary}} — kontynuować do final verify?"

  - id: final-verify
    type: check
    name: agent-verify.sh (final)
    command: scripts/agent-verify.sh
    retryOn: [1]
  - { id: final-retry, type: loop, name: Poprawka reviewera, max: 1 }
  - id: review-fix
    type: agent
    name: Reviewer — poprawka checków
    runner: claude
    model: claude-opus-5-5
    session: { continue: review }
    prompt: "Finalny `scripts/agent-verify.sh` nie przeszedł po Twoich zmianach. Napraw przyczynę minimalnie; bez refactorów."

  - { id: done, type: end, name: Gotowe do review, status: success }
  - { id: impl-gave-up, type: end, name: Implementer nie przeszedł checków, status: failed }
  - { id: final-gave-up, type: end, name: Final verify czerwony, status: failed }
  - { id: stopped, type: end, name: Zatrzymane, status: failed }

edges:
  - { from: start, to: approve-mcp }
  - { from: approve-mcp.pass, to: implement }
  - { from: implement.done, to: verify }
  - { from: verify.pass, to: review }
  - { from: verify.fail, to: impl-retry }
  - { from: impl-retry.repeat, to: impl-fix }
  - { from: impl-retry.exhausted, to: impl-gave-up }
  - { from: impl-fix.done, to: verify }
  - { from: review.clean, to: final-verify }
  - { from: review.fixed, to: final-verify }
  - { from: review.blocked, to: blocked-gate }
  - { from: blocked-gate.approve, to: final-verify }
  - { from: blocked-gate.reject, to: stopped }
  - { from: final-verify.pass, to: done }
  - { from: final-verify.fail, to: final-retry }
  - { from: final-retry.repeat, to: review-fix }
  - { from: final-retry.exhausted, to: final-gave-up }
  - { from: review-fix.done, to: final-verify }
```

Uwagi do grafu:
- `done` (end success) → `settleSuccess` → review gate (gdy `reviewGate: true`) → Changes / draft PR / człowiek.
  Brak węzła `github.draft-pr` celowo: PR robi człowiek z review gate.
- Wynik nieudanego `verify` jest dopisywany do `impl-fix` automatycznie — dlatego prompt go nie wkleja.
- Przy `retryOn: [1]` exit `2` (środowisko) kończy run od razu z kodem w komunikacie, bez palenia retry.
- Werdykt Reviewera to od razu metryka „ile defektów znajduje”: `clean` vs `fixed` vs `blocked`.
- Przed wdrożeniem: sprawdzić plik przez edytor workflow w kokpicie (walidacja `graphIssues`).

## 12. Plan wdrożenia pilota

1. **AltflowMetrics — infrastruktura weryfikacji**: `scripts/agent-verify.sh` wg §10, `DJANGO_TEST_DB_NAME`,
   zielony przebieg na czystym `dev` (2× pod rząd, raz równolegle z drugim worktree).
2. **AltflowMetrics — reguły agentów**: sekcja „pod Cezarem” w `youtrack-ticket.mdc` / `CLAUDE.md`.
3. **AltflowMetrics — Cezar**: `reviewGate: true`, workflow z §11.
4. **Dry run**: jeden ticket-zabawka; potwierdzić, że Reviewer widzi MCP YouTrack, że nikt nie robi
   commita/pusha/PR, że run kończy w `review`.
5. **Cezar — C2 + C4** (małe, czysto korzystne), potem **C1/C3** jeśli pilot potwierdzi potrzebę.
6. **Pilot: 5–8 małych, prawdziwych ticketów.** Dla każdego zapisać: werdykt Reviewera, liczba i waga
   znalezisk, czy poprawki były wartościowe (ocena człowieka przy review), czy były zbędne zmiany
   (diff Reviewera poza zakresem ticketu), `costUsd` kroku `review`, tokeny i koszt Cursora,
   liczba rund `impl-retry`, exit `2` (niestabilność środowiska), czas całego runu.
7. Decyzja o STANDARD / HIGH RISK dopiero na tych danych (później: węzeł `if` z `paths-changed`
   na `**/migrations/**` itp. jest już w silniku).

## 13. Branch / commit / PR dla zadań z YouTrack (plan, 2026-10-15)

Stan dziś: branch zawsze `branchFor(runId)` = `cez/<id8>` (`git-worktree.ts:76`); commity Cezara to
`cezar autosave (<reason>)`, węzeł `git.commit` i przycisk Commit w kokpicie; PR `createDraftPr`
(`server/forge/github.ts`) z tytułem `run.title` i `--base run.baseBranch`, wołany w DWÓCH miejscach
(`POST /runs/:id/pr` i węzeł `github.draft-pr`). Run startowany z zakładki YouTrack NIE niesie ID
ticketu — `trackerRunBody` wysyła tylko `task`/`workflow`/`runner`/`model`. Klient YouTrack jest tylko
do odczytu (GET). Nic nie parsuje nazwy brancha z powrotem na id runu.

Plan (każdy punkt: zmiana tylko gdy `run.trackerItem` istnieje; bez niego zachowanie bajt-w-bajt jak dziś,
przypięte testami-strażnikami):

1. **Metadana** `trackerItem: { kind: 'youtrack', id, url }` — opcjonalna w `createRunInputBaseSchema` i
   `runRecordSchema` (contract), zapisywana przy tworzeniu runu, niemutowalna. Serwer waliduje
   `id` regexem `^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,8}$` (trafia do nazwy refa, commita, tytułu PR)
   i zgodność `kind` z asocjacją trackera projektu. Kokpit ustawia ją w `trackerRunBody`.
2. **Branch** `cez/<ID>-<id8>`: `branchFor(runId, ticketId?)`; `createWorktree` dostaje opcjonalny
   `branch`; ponowne użycie / `retention` rematerializuje z `run.branch` (inaczej sprawdzenie
   `atPath.branch !== branchRef` rzuci); `pruneOrphans` bierze branch z `git worktree list`
   zamiast z nazwy katalogu. Worktree `.ai/cezar/worktrees/<runId>` bez zmian.
3. **Commity Cezara**: prefiks `[<ID>] ` w `autosaveCommit`, węźle `git.commit` i trasie Commit
   (gdy wiadomość jeszcze nie zawiera ID). Commity agentów — tylko instrukcją w promptach.
4. **PR**: w `createDraftPr` tytuł `[<ID>] <title>` (gdy nie zaczyna się od niego), link do ticketu
   w treści; base bez zmian (`run.baseBranch` → `dev`). Jedno miejsce obsługuje oba wywołania.
5. **Status po PR** (opt-in): helper `onPullRequestCreated` wołany z obu miejsc, tylko przy
   `outcome.ok && !dryRun`; `POST /api/commands` YouTrack z nazwą stanu z ustawień połączenia
   (domyślnie brak → brak zapisu); wynik jako nota w runie i pole na rekordzie (idempotencja);
   błąd nigdy nie psuje PR. Alternatywa bez kodu: reguła workflow w YouTrack na zdarzenie PR z
   integracji VCS GitHub — do sprawdzenia, czy jest u was skonfigurowana.

### 13.1 Stan (2026-10-15)

Punkty 1–4 zaimplementowane (`src/tracker-item.ts` + kontrakt `runTrackerItemSchema`); branch
`cez/<ID>-<id8>` (decyzja: id8, jak dotąd). Punkt 5 **nie** w Cezarze — decyzja: najpierw reguła
w YouTrack, napędzana zdarzeniem PR z integracji VCS GitHub, więc status zależy od FAKTYCZNIE
otwartego PR, niezależnie od tego, kto go otworzył.

Do sprawdzenia w YouTrack (altflow.youtrack.cloud), w kolejności:
1. Projekt → Settings → VCS Integrations: czy jest integracja z `altflow-dev/AltflowMetrics`
   i czy PR-y pojawiają się w activity ticketu, gdy tytuł zawiera `TERM-396`.
2. Czy draft PR z GitHuba trafia do YouTrack ze stanem `OPEN` (drafty bywają traktowane osobno).
3. Czy w polu State istnieje wartość dokładnie „Do zweryfikowania”.

Szkic reguły (on-change; NIESPRAWDZONY — API `pullRequests` / `PullRequestChange.state`
według dokumentacji devportalu; przetestować na projekcie testowym). Warunek na prefiks `[ID]`
w tytule PR ogranicza regułę do PR-ów z Cezara, żeby nie ruszać ręcznego workflow Cursora,
który sam ustawia statusy — o ile encja PR wystawia tytuł; jeśli nie, warunek trzeba usunąć
i świadomie zaakceptować, że reguła obejmie też PR-y ręczne.

```js
const entities = require('@jetbrains/youtrack-scripting-api/entities');

exports.rule = entities.Issue.onChange({
  title: 'PR z Cezara otwarty → Do zweryfikowania',
  guard: (ctx) => ctx.issue.pullRequests.added.isNotEmpty(),
  action: (ctx) => {
    const prefix = '[' + ctx.issue.id + ']';
    let opened = false;
    ctx.issue.pullRequests.added.forEach((change) => {
      const pr = change.pullRequest;
      const title = (pr && pr.title) || '';
      if (change.state && change.state.name === 'OPEN' && title.indexOf(prefix) === 0) opened = true;
    });
    if (opened && !ctx.issue.fields.is(ctx.State, ctx.State.Review)) {
      ctx.issue.fields.State = ctx.State.Review;
    }
  },
  requirements: {
    State: { type: entities.State.fieldType, Review: { name: 'Do zweryfikowania' } },
  },
});
```
