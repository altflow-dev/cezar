# Środowiska podglądu (preview) po zadaniu

Status: **zaimplementowany** (2026-11-24), patrz § Fazy i § Weryfikacja.

## Cel

Gdy zadanie dojdzie do review, cezar stawia aplikację z brancha zadania w dockerze i pokazuje
w widoku zadania:

- linki do frontendu i backendu (`http://<host serwera>:<port>`),
- testowego użytkownika i hasło z seedu,
- listę zmienionych plików i checklistę „co sprawdzić”,
- przyciski Restart / Stop / Logi.

Każde zadanie dostaje własne porty, więc kilka podglądów (także z różnych projektów) działa
naraz. cezar nadal niczego nie merguje: podgląd tylko pomaga przy ręcznym review.

## Decyzje (właściciel, 2026-11-24)

| Pytanie | Decyzja |
| --- | --- |
| Skąd cezar wie, jak postawić aplikację | Commitowany plik w repo: `.ai/cezar/preview.yml`. Bez niego cezar próbuje wykryć `compose.yaml` / `docker-compose.yml`. |
| Jak użytkownicy się dostają | Bezpośrednio po IP/hoście serwera + port (VPN/LAN), bez reverse proxy. |
| Kiedy gasić | Po archiwizacji, usunięciu lub merge'u; przyciskiem Stop; po TTL; po przekroczeniu limitu równoległych podglądów. |
| Zakres teraz | Najpierw sam spec. |

## Dziś: co już jest i czego brakuje

- Grafy workflow v2 (`workflows/graph.ts`, wykonywanie w `workflows/run.ts` `case '<type>'`) mają
  węzły systemowe (`git.push`, `github.wait-ci`, …). Brakuje węzła, który odpala coś długożyjącego
  i *nie kończy się razem ze swoim krokiem*.
- Węzeł `check` uruchamia polecenie powłoki w worktree, ale proces musi się zakończyć i nikt potem
  po nim nie sprząta. Postawienie `docker compose up -d` jako checka „działa”, tylko że kontenery
  zostają na zawsze, porty się gryzą (`5456` z pilota AltflowMetrics,
  `2026-10-15-ticket-implement-review-workflow.md` §8.3) i w UI nie ma żadnego URL-a.
- Stany końcowe, od których podgląd musi zależeć: archiwizacja (`POST /runs/:id/archive`), usunięcie
  (`DELETE /runs/:id`), usunięcie worktree (`/remove-worktree`, `reclaimWorktrees` w
  `runs/retention.ts`). Stan PR (merged/closed) cezar już odpytuje dla chipów referencji
  (`server/forge/github.ts`). Implementacja musi potwierdzić, czy da się się tam podpiąć.

## Plik `.ai/cezar/preview.yml`

Commitowany (jak `workflows/` i `skills/`). Każde pole jest opcjonalne.

```yaml
# Który compose. Domyślnie: wykryj compose.yaml / compose.yml / docker-compose.yml / docker-compose.yaml.
compose: docker/compose.yml          # albo lista plików: [compose.yml, compose.preview.yml]

# Pliki ignorowane przez gita, których worktree nie ma, a build ich potrzebuje.
# Kopiowane z checkoutu projektu do worktree przed buildem (tylko ścieżki względne wewnątrz repo).
copyFromRoot:
  - .envs/.env

# Dodatkowe zmienne dla `docker compose` (interpolacja ${VAR} w compose).
env:
  DJANGO_DEBUG: "1"

# Usługi wystawiane na zewnątrz. Klucz to etykieta w UI. Wszystkie INNE opublikowane porty
# z compose są zdejmowane (patrz „Izolacja”), żeby baza z dev-compose nie zajęła 5456 dwa razy.
expose:
  frontend: { service: web, port: 5173, path: / }
  backend:  { service: api, port: 8000, path: /admin/ }

# Kiedy uznać podgląd za gotowy. Domyślnie: `up --wait` (healthchecki z compose) i GET na pierwszy
# `expose` zwraca < 500.
ready:
  url: backend
  path: /health/
  timeoutSec: 300

# Seed danych, odpalany raz po `ready` przez `docker compose exec -T`.
seed:
  - { service: api, command: "python manage.py migrate --noinput" }
  - { service: api, command: "python manage.py loaddata dummy_data" }

# Tylko testowe dane logowania z seedu. To NIE jest miejsce na sekrety: pole jest pokazywane
# w cockpicie każdemu, kto ma do niego dostęp.
credentials:
  - { label: Admin, url: backend, user: admin@example.com, password: admin123 }
  - { label: Klient, url: frontend, user: demo@example.com, password: demo123 }

# Podpowiedzi do checklisty, które trafiają do promptu agenta piszącego notatki testowe.
checklistHints: |
  Zawsze sprawdź logowanie i dashboard. Zmiany w `billing/` testuj na koncie Klient.
```

Bez pliku, ale z wykrytym compose: wystawiane są wszystkie opublikowane porty, a etykietą jest nazwa
usługi. Nie ma wtedy seedu ani danych logowania, a karta w UI podpowiada, żeby dodać `preview.yml`.
Bez compose węzeł kończy się portem `failed` z notatką „brak compose / preview.yml”.

Schemat siedzi w zod (`packages/cezar/src/preview/config.ts`), `.passthrough()` nie jest potrzebny,
bo to config autorski, nie stan. Nieznany klucz daje błąd przy ładowaniu z nazwą pola.

## Węzeł workflow `preview.up`

```ts
z.object({ ...nodeBase, type: z.literal('preview.up'),
  notesFrom: z.string().optional(),        // id węzła agent, którego `summary` to notatki testowe
  trustWorktreeConfig: z.boolean().default(false) })
```

- Porty: `ready`, `failed`. Wyjścia: `frontendUrl`, `backendUrl` (względne `:port/path`; host
  dokleja klient, patrz niżej), `ports`, `output` (ogon logu builda).
- `failed` podpięte do agenta działa jak pętla `check`: log builda trafia do promptu ponownej próby.
  Przykład: agent zepsuł Dockerfile, więc dostaje log i poprawia.
- Wpis w `NODE_CATALOG` (kategoria `scripts`, etykieta „Preview”) i w edytorze węzłów (formularz:
  `notesFrom`, `trustWorktreeConfig`). Na szynie kroków to wiersz typu `check`.
- Workflow v1 (lista `steps`) nie dostaje tego kroku. Podgląd jest tylko w grafach i w nowym
  szablonie `implement-review-preview` (`workflows/templates.ts`):
  `start → implement → check(testy) → agent „Notatki testowe” → preview.up → end`, a `failed`
  z `preview.up` wraca do `implement` przez `loop(max 2)`.

### Wykonanie (`preview/engine.ts`)

1. Sprawdzenie wymagań: `docker compose version` ≥ 2.24 (potrzebne `!reset`/`!override`).
   Bez dockera węzeł zwraca `failed` z notatką. Boot nigdy nie pada.
2. Konfiguracja: `preview.yml` + compose czytane **z brancha bazowego** (`git show <base>:<path>`),
   chyba że `trustWorktreeConfig: true` (patrz „Bezpieczeństwo”). Kontekst builda (Dockerfile,
   kod) zawsze pochodzi z worktree, bo właśnie to testujemy.
3. `copyFromRoot` → worktree (tylko pliki istniejące w checkoucie projektu, ścieżka nie wychodzi poza
   repo, nic nie nadpisuje).
4. Przydział portów (patrz niżej), potem wygenerowanie override'u w
   `.ai/cezar/previews/<runId>/override.yml`.
5. `docker compose -p cez-<projectSlug>-<id8> -f <compose…> -f override.yml up -d --build --wait
   --wait-timeout <ready.timeoutSec>`, a stdout/stderr idą do eventów runu jak przy `check`
   (z limitem jak `DIFF_CAP`).
6. Lint wynikowej konfiguracji: `docker compose … config --format json` *przed* `up` (patrz
   „Bezpieczeństwo”).
7. Sonda `ready` (HTTP GET z hosta na `bind:port`), potem `seed`, potem zapis `run.preview`.
8. Notatki: `summary` z węzła `notesFrom` + deterministyczna lista zmienionych plików z
   `resolveTaskDiffBase` (jedno źródło prawdy o diffie zadania, AGENTS.md).

Build trzyma slot `maxParallel`, bo to praca CPU, tak samo jak check. Gotowy podgląd slotu już nie
trzyma (run idzie do `review`). Liczy się za to do limitu podglądów.

### Prompt węzła „Notatki testowe” (w szablonie)

Agent dostaje diff, `checklistHints` i dane logowania. Ma zwrócić Markdown z sekcjami
**Co się zmieniło** (2–6 punktów, językiem użytkownika) i **Co sprawdzić** (checklista `- [ ]`
z konkretnymi ekranami/URL-ami i kontem, którym się zalogować). Model jest do wyboru w węźle.
W szablonie domyślnie ten sam runner co implementacja.

## Porty, host i izolacja

- **Zakres portów:** `CEZ_PREVIEW_PORTS`, domyślnie `41000-41999`. Przydział jest dla całego
  workspace'u, bo na jednym serwerze jest wiele projektów. Trzyma go osobny plik
  `~/.cezar/previews.json` (wzorem `agent-accounts.json`, nie klucz w `config.json`), zapisywany
  przez read-modify-write + atomowy rename. Każdy port jest dodatkowo sprawdzany `listen()` przed
  przydziałem. Uszkodzony plik oznacza „brak przydziałów”, a reconcile przy starcie odbudowuje go
  z `docker compose ls`.
- **Override:** dla usług z `expose` jest `ports: !override ["<bind>:<hostPort>:<port>"]`, dla
  wszystkich pozostałych usług z opublikowanymi portami `ports: !reset []`, a każde `container_name`
  dostaje `!reset null`. Każda usługa (poza tymi z `network_mode`) dostaje też alias
  `<usługa>.localhost` w każdej swojej sieci. `@altcomp/auth-fetch` 2.x przyjmuje `http://` tylko
  dla nazw loopback, więc `API_URL=http://api:8000` jest odrzucane, a `http://api.localhost:8000`
  nie. AltDesk dodaje ten alias ręcznie w swoim compose. Alias działa tylko w sieci projektu, a
  compose łączy go z aliasami z pliku. Sprawdzone na dockerze: Node (alpine) i glibc rozwiązują go
  przez DNS dockera. Wolumeny nazwane są izolowane przez `-p` (nazwa projektu compose). Bind
  mounty spoza worktree odrzuca lint.
- **Adres bind:** `CEZ_PREVIEW_BIND`. Domyślnie ten sam interfejs, na którym nasłuchuje sam cezar:
  `127.0.0.1` lokalnie, a na serwerze wystawionym w sieci to, co ma cezar. Podgląd nigdy nie jest
  bardziej wystawiony niż cockpit, więc to nie jest nowe poszerzenie ekspozycji.
  **Uwaga:** docker publikuje porty przez iptables, z pominięciem `ufw`. Trzeba to opisać
  w `docs/reference.md`.
- **Host w URL-u:** dokleja go klient z `window.location.hostname`. Skoro ktoś widzi cockpit pod
  `http://10.0.0.5:4321`, podgląd jest pod `http://10.0.0.5:41023`. Nic nie trzeba konfigurować,
  a serwer nie musi znać swojego publicznego adresu.

## Stan na rekordzie runu

Nowe opcjonalne pole `RunRecord.preview` (`.optional().catch(undefined)`, stare pliki się parsują):

```ts
{ status: 'building' | 'ready' | 'failed' | 'stopped' | 'stale',
  composeProject: string,
  ports: { label: string; service: string; hostPort: number; path: string }[],
  credentials?: { label: string; url?: string; user: string; password: string }[],
  notes?: string,               // Markdown z węzła notatek
  changedFiles?: string[],
  builtFromSha: string,
  startedAt: string, readyAt?: string, expiresAt: string,
  stoppedAt?: string, stopReason?: 'user' | 'archived' | 'deleted' | 'merged' | 'ttl' | 'limit' | 'worktree-removed' | 'boot-missing',
  error?: string }
```

`credentials` i `notes` są zapisane w chwili budowy, bo `preview.yml` na branchu może się później
zmienić. Schemat leży w `packages/contract` (`previewStateSchema`), typ jest inferowany.

## Cykl życia: wszystkie przejścia

Każdy stan ma wyjście, które działa przy ustawieniach domyślnych (AGENTS.md, „Enumerate the
transitions”).

| Ze stanu | Do | Kto to odpala |
| --- | --- | --- |
| — | building | węzeł `preview.up` albo przycisk Restart |
| building | ready | sonda `ready` + seed OK |
| building | failed | błąd compose/lint/seed, lub `ready.timeoutSec` (domyślnie 300 s) albo twardy limit builda 15 min. **Zawsze ograniczony czasowo.** |
| building | stopped | anulowanie runu (`/cancel`): engine zabija drzewo procesów (#8) i robi `down` |
| ready / failed | stopped | Stop; archiwizacja; usunięcie runu; usunięcie/reclaim worktree; PR merged/closed; TTL; limit |
| ready | stale | nowa tura agenta (Continue / wiadomość), która zmieniła HEAD worktree: badge „nieaktualny – Restart” (bez automatycznego rebuildu) |
| stale | building | Restart |
| dowolny (po restarcie cezara) | stopped (`boot-missing`) | reconcile: rekord `ready`, ale kontenerów nie ma |

- **TTL:** `CEZ_PREVIEW_TTL_HOURS`, domyślnie 24 h od `readyAt`. Przycisk „Przedłuż” dodaje kolejne
  24 h. Prawdziwej bezczynności (ruchu HTTP) nie mierzymy, bo wymagałoby to proxy. TTL od startu jest
  uczciwym zamiennikiem.
- **Limit:** `CEZ_PREVIEW_MAX`, domyślnie 4 gotowe podglądy na cały workspace. Nowy podgląd ponad
  limit gasi najstarszy `ready` (`stopReason: 'limit'`) i dopisuje notatkę do obu runów.
- **Sweep:** jeden timer w `RunManager` co 5 min (TTL, limit, PR merged/closed, osierocone projekty
  compose `cez-*` bez rekordu). Uzbraja go boot, a nie pierwszy podgląd, więc po restarcie TTL nadal
  działa. Reconcile przy starcie nie blokuje bootu.
- **`down`** zawsze jako `docker compose -p … down -v --remove-orphans --rmi local`. Kasuje wolumeny
  i obrazy budowane lokalnie, żeby dysk serwera nie puchł. Porty są zwalniane w `previews.json`
  w tym samym zapisie.
- Każda ścieżka do stanu końcowego idzie przez **jeden helper** `stopPreview(runId, reason)`,
  wołany z handlerów archive, delete, remove-worktree, `reclaimWorktrees`, cancel i sweepa. Test
  sprawdza każde wywołanie (lekcja z #811: dwa miejsca konstrukcji tego samego obiektu).

## HTTP API

Wszystko w jednej łańcuchowej rodzinie `preview` (montowanej pod `/api/v1/` i
`/api/v1/p/:projectId/`), walidacja przez trio z `validators.ts`, kształty w `packages/contract`:

| Trasa | Co robi |
| --- | --- |
| `GET /runs/:id/preview` | `previewStateSchema` albo `{ available: false, reason }` (brak dockera / brak configu) |
| `POST /runs/:id/preview/up` | Restart/rebuild z aktualnego HEAD worktree (409, gdy run aktywny albo worktree nie istnieje) |
| `POST /runs/:id/preview/down` | Stop (`stopReason: 'user'`) |
| `POST /runs/:id/preview/extend` | `expiresAt += TTL` |
| `GET /runs/:id/preview/logs?service=&tail=` | Ogon `docker compose logs` (limit bajtów) |

Wymagania z AGENTS.md: wpis do `BACKWARD_COMPATIBILITY.md` §2, `contract-parity*`, `route-parity`,
`typed-bodies`. Zmiany `run.preview` jadą istniejącym SSE `run`, więc nowego kanału nie ma.

## Cockpit

- **Karta „Podgląd”** w `routes/task-thread/review-panel.tsx` nad diffem:
  - chip statusu (Buduje… / Gotowy / Błąd / Zatrzymany / Nieaktualny) + „wygasa za 17 h”,
  - przyciski-linki dla każdego `expose` (`target="_blank"`, `rel="noopener"`),
  - dane logowania z przyciskiem kopiowania (hasło domyślnie zamaskowane, z przełącznikiem „pokaż”),
  - notatki (Markdown, istniejący renderer `markdown.tsx`). Checkboxy działają lokalnie, stan
    zapisywany przez istniejące szkice per run (#939), więc współpracownik ma własną checklistę,
  - lista zmienionych plików (klik otwiera plik w zakładce Changes),
  - Restart / Stop / Przedłuż / Logi (dialog z ogonem logów per usługa).
- **Chip w liście zadań** (`tasks-overview`): `▶ podgląd` dla `ready`, z linkiem do frontendu.
- Wszystkie napisy przez `t()`/`tp()` i wpisy w `locales/pl.ts`.

## Bezpieczeństwo

Docker na serwerze to w praktyce root, a kod builda pisze agent. Stąd:

1. **Compose i `preview.yml` z brancha bazowego** (domyślnie). Agent może zmieniać Dockerfile,
   bo `RUN` wykonuje się w kontenerze, ale nie może dopisać sobie `volumes: ["/:/host"]` w compose.
   `trustWorktreeConfig: true` to świadome zezwolenie autora workflow, dla zadań, które same zmieniają
   konfigurację dockera.
2. **Lint wynikowej konfiguracji** (zawsze, także przy zaufaniu): odrzuca `privileged`, `cap_add`,
   `network_mode: host`, `pid: host`, `ipc: host`, `devices`, montowanie `docker.sock` i bind mounty
   spoza worktree (wolumeny nazwane są OK).
3. Dane logowania są oznaczone jako testowe. Lint `preview.yml` ostrzega (nie blokuje), gdy wartość
   wygląda na prawdziwy sekret (`sk-`, `ghp_`, długie losowe ciągi).
4. Porty podglądu są bindowane jak sam cezar (patrz wyżej), nigdy szerzej.
5. `CEZ_DRY_RUN=1`: engine nie dotyka dockera, zwraca sztuczny podgląd `ready` z portami z zakresu,
   tak żeby e2e i UI dało się przetestować offline.

## Zmienne środowiskowe (`.env.example` + `docs/reference.md` w tym samym commicie)

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `CEZ_PREVIEW` | włączone | `0` wyłącza węzeł (kończy się `failed` z notatką) i sweep, ale sweep nadal gasi istniejące podglądy |
| `CEZ_PREVIEW_PORTS` | `41000-41999` | zakres portów hosta |
| `CEZ_PREVIEW_BIND` | adres bind cezara | interfejs publikowania portów |
| `CEZ_PREVIEW_MAX` | `4` | max gotowych podglądów na workspace |
| `CEZ_PREVIEW_TTL_HOURS` | `24` | czas życia od `readyAt` |

Domyślne włączenie (ratyfikowane 2026-11-24) jest w porządku względem zasady „opt-in dla ekspozycji/kosztu”: nic się nie
dzieje, dopóki autor workflow nie doda węzła `preview.up`, a ekspozycja nie przekracza ekspozycji
cockpitu. Wpis do AGENTS.md § Zero config, tak jak przy dispatch i automatyzacjach.

## `.ai/cezar/.gitignore`

`previews/` (override'y, logi) dochodzi do allowlisty `ensureDataGitignore`, a `preview.yml` nie
(ma być commitowany). `data-gitignore.test.ts` to wyłapie.

## Fazy

1. **Engine + węzeł — ZROBIONE (2026-11-24).** `src/preview/config.ts` (zod + wykrywanie compose),
   `ports.ts` (`~/.cezar/previews.json`), `compose-model.ts` (plan portów, override, lint),
   `engine.ts` (up/down/logs, dry-run), `bind.ts`, gałąź `preview.up` w `run.ts`,
   `RunRecord.preview`, kontrakt (`packages/contract/src/preview.ts`), węzeł w edytorze.
2. **Cykl życia — ZROBIONE (2026-11-24).** `PreviewReaper` (`src/preview/reaper.ts`) słucha
   store'a (`run`/`deleted`), więc łapie archive, archive-finished, pick wariantu, delete,
   remove-worktree i reclaim jednym miejscem. Do tego: sweep TTL co 5 min (uzbrajany przy
   starcie), reconcile przy starcie (`boot-missing`), anulowanie w trakcie builda i PR
   merged/closed. Stan PR jest czytany **tylko z cache** chipów (`readCachedRefStatuses`), więc
   bez nowego ruchu do GitHuba. Limit `CEZ_PREVIEW_MAX` (domyślnie 4, dla całego workspace'u):
   build gasi najstarszy podgląd; podgląd z innego projektu jest gaszony przez docker i znaczony
   w `previews.json` (`evicted`), a jego reaper zapisuje `limit`. Status `stale` zależy od
   **zawartości plików** (`worktreeTreeId`: `git write-tree` przez tymczasowy index), nie od
   HEAD, bo autosave cezara commituje te same bajty przy końcu tury.
   Przy starcie zatrzymywane są też osierocone stacki tego projektu: dokładnie `cez-<projekt>-<id8>`
   bez rekordu, który by je posiadał. Stacki innych projektów i nazwy obce nie są ruszane.
3. **API + cockpit — ZROBIONE (2026-11-24).** Trasy `POST /runs/:id/preview/{restart,stop,extend}`
   i `GET /runs/:id/preview/logs` (rodzina `previewRoutes`). `restart` buduje w tle (202) przez
   ten sam `buildPreview` co węzeł, z tymi samymi portami, notatkami i poziomem zaufania do
   konfiguracji. Do tego karta „Podgląd” (`routes/task-thread/preview-card.tsx`) nad bramką
   review, chip `podgląd` w tabeli zadań i tłumaczenia PL. Zmiana względem projektu: nie ma
   `GET /runs/:id/preview`, bo stan jest polem rekordu i przychodzi przez SSE `run`. Checklista
   w notatkach renderuje się jako Markdown, bez zapisywanego stanu odhaczeń.
4. **Szablon + dokumentacja — ZROBIONE.** Szablon nazywa się `implement-and-preview`
   (implement → testy → notatki → preview, z pętlą naprawy builda). Są `docs/reference.md`
   (sekcja *Task previews*), `.env.example` i wpis w AGENTS.md. Notatki testowe trafiają do opisu
   draft PR (sekcja `## Testing`, z zamaskowanymi hasłami). Przykład dla AltflowMetrics leży
   w `assets/2026-11-24-altflowmetrics-preview.yml`: sprawdzony `docker compose config` + lint,
   bez pełnego `up`.
5. **Dodane po drodze: `serviceEnv`.** Wyszło przy AltflowMetrics: `.envs/.env` wskazuje
   `localhost:8000`, więc frontend podglądu pukałby do złego backendu, a Django odrzucałoby host.
   `serviceEnv` z `{host}`, `{port:x}` i `{url:x}` trafia do override'u jako `environment`
   usługi. `{host}` pochodzi z ostatniego żądania przeglądarki do cockpitu (`Sec-Fetch-Site:
   same-origin`, którego CLI agenta nie wysyła), z `CEZ_PREVIEW_HOST` albo z nazwy maszyny.

## Weryfikacja na prawdziwym dockerze (2026-11-24, compose v5.5.1)

Dwa podglądy jednego projektu naraz (nginx + budowane API w Pythonie + „baza” z `5456`
i `container_name`) wstały na rozłącznych portach. Każdy serwował kod ze swojego worktree,
`serviceEnv`, `copyFromRoot` i seed zadziałały, port 5456 nie był opublikowany. Po `down` nie
zostały kontenery, obrazy ani wpisy w ledgerze. `privileged` i mount `/etc` dopisane na branchu
zadania: z `trustWorktreeConfig` odmowa, bez niego użyty compose z bazy.

## Testy (minimum)

- `override.test.ts`: porty spoza `expose` dostają `!reset`, `container_name` jest zdejmowane,
  dwa runy dostają rozłączne porty.
- `ports.test.ts`: zajęty port jest pomijany, zwolnienie przy `down`, uszkodzony
  `previews.json` oznacza pusty stan, a reconcile go odbudowuje.
- `lint.test.ts`: każdy zakazany klucz odrzucony; bind mount wewnątrz worktree przepuszczony.
- `config.test.ts`: wykrywanie compose bez `preview.yml`; brak compose daje `failed`, a nie throw;
  **pusty/nieobecny config ma pokrycie** (AGENTS.md: fail-open helper z testem pustego wejścia).
- `preview-lifecycle.test.ts`: każda z 7 dróg do `stopped` woła `stopPreview` (archive, delete,
  remove-worktree, reclaim, cancel, TTL, limit); restart cezara z rekordem `ready` bez kontenerów
  daje `boot-missing`. Regresje mają być **czerwone bez fixa** (`git stash push -- <src>`).
- Graf: `failed` → agent dostaje log builda w prompcie; `CEZ_DRY_RUN=1` przechodzi cały szablon.
- Cockpit: karta renderuje wszystkie statusy, host z `window.location`, hasło zamaskowane, i18n.
- e2e (dry-run): szablon kończy się w review z kartą „Gotowy” i działającym Stop.

## Rozstrzygnięte (właściciel, 2026-11-24)

- **Zadania bez worktree** (praca w checkoucie repo): podgląd nie jest stawiany, węzeł kończy się
  `failed` z notatką.
- **`CEZ_PREVIEW_MAX = 4`** zostaje. Serwer ma 40 GB RAM, co wystarcza na 4 stacki naraz.
- **Notatki testowe trafiają do opisu draft PR.** `github.draft-pr` (i `github.pr-update`)
  dokleja sekcję „Co się zmieniło / Co sprawdzić” z `run.preview.notes`, gdy istnieje. Hasła **nie**
  trafiają do PR. URL-i podglądu też nie, bo są osiągalne tylko z sieci serwera.

- **Pliki `.env` spoza gita** są kopiowane z folderu projektu na serwerze (`copyFromRoot`). Nie ma
  osobnego magazynu w Settings.
- **Domyślne włączenie ratyfikowane:** podgląd działa, gdy tylko workflow ma węzeł `preview.up`.
  `CEZ_PREVIEW=0` to wyłącznik awaryjny. Przy implementacji trzeba dopisać wyjątek do AGENTS.md
  § Zero config („Owner-approved exception (2026-11-24): preview environments…”).

## Otwarte pytania

Brak.
