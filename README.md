# opencode-inbox-compact

GUI-плагин OpenCode: однострочный компактный список сессий в сайдбаре для
раскладки интерфейса **Inbox** + иконка-переключатель 28×28 в шапке сайдбара,
рядом с иконками других плагинов.

## Зачем

В раскладке Inbox каждая сессия занимает две строки: название, а под ним —
проект/ветка и прижатые к правому краю индикатор состояния и прошедшее время,
всё внутри блока 54 px. Плагин оставляет одну строку 24 px: убирает
проект/ветку, но **сохраняет индикатор и время** — кружок `done/failed/approval`,
`ActivityRing` выполняющейся сессии и `49m`/`3d` остаются на месте.

Категории (`Needs attention`, `Unread`, `Recent`, `Working`), их заголовки,
счётчики, контекстное меню и остальной механизм Inbox не меняются.

## Что делает

Разметка записи (проверено по живому DOM, OpenCode 2.3.0):

```
button[data-slot="sidebar-inbox-item"]      h-[54px] flex-col gap-1.5 p-2
├── span                                    аватар проекта + название
└── span                                    вторая строка (h-4, ps-6)
    ├── span.absolute                       значок сервера (если серверов несколько)
    ├── span.flex-1                         проект · worktree · branch   ← скрывается
    └── span (ms-auto)                      sr-only статус · точка/ActivityRing · время  ← остаётся
```

Правила (все — только под `html[data-oc-inbox-compact]`):

- запись становится grid-ом `minmax(0,1fr) auto`: название слева, метаданные
  справа, высота `54 → 24 px`, `padding 8 → 2px 8px`, `gap 6px`, радиус 4 px;
- вторая строка перестаёт быть отдельной строкой (`position: static`,
  `width: auto`, `padding: 0`) и целиком уезжает в правую колонку;
- скрывается только `> span.flex-1` (проект/ветка); значок сервера
  (`> span.absolute`) становится строчным и остаётся;
- `[data-slot="sidebar-inbox-scroll"]`: `gap 2 → 1 px`.

## Переключатель

Иконка 28×28 в шапке сайдбара — в том же ряду, где живут иконки других
плагинов: часы `opencode-session-timestamps` (`[data-ocst-kind="toggle"]`) и
пилюля `opencode-llama-swap-stats`. Оба плагина переносят свои элементы в
`[data-slot="sidebar-header"]` перед кнопкой сворачивания
(`button[aria-controls="vertical-tabs-sidebar"]`); этот плагин делает так же.

Почему не `TitlebarItem`: в vertical/Inbox-раскладке хост рисует этот реестр в
`[data-slot="vertical-tabs-footer"]`, то есть в самом низу сайдбара.

Стилистика повторяет `.ocst-toggle` из session-timestamps:

- ghost-кнопка 28×28, `border-radius: 6px`, прозрачный фон, 16×16 иконка
  `var(--v2-icon-icon-muted)`, hover — `--v2-overlay-simple-overlay-hover` и
  `--v2-text-text-base`, `-webkit-app-region: no-drag`;
- иконка — системная из спрайта хоста: `<use href="#opencode-v2-icon-align-right">`;
- `data-on="true"` — включено (цвет base), `data-on="false"` — выключено
  (`text-faint`, `opacity: .65`);
- подпись в `aria-label`/`title` локализована (`en` — `Compact list`,
  `ru` — `Компактный список`) и следует за `document.documentElement.lang`;
- состояние (`aria-pressed`, `data-on`) хранится в `Store.global`, переживает
  перезапуск;
- иконка видна только когда в документе есть `[data-slot="sidebar-inbox"]`
  (CSS `html:not(:has(...))`), и переприкрепляется, если Solid пересобрал шапку:
  MutationObserver проверяет запомненный слот за четыре чтения свойств и делает
  запрос к документу только когда шапка действительно исчезла (без шапки проба
  идёт не чаще двух раз в секунду).

Дублирующая команда для палитры: `inbox-compact.toggle`.

## Устройство

| Файл | Назначение |
|---|---|
| `src/gui.cjs` | `./gui-experimental` — один CommonJS-файл, как требует загрузчик GUI-плагинов |
| `test/unit.mjs` | 30 офлайн-проверок: экспорт, CSS, инъекция, состояние, язык, стоимость перерисовки |

Хост сам подставляет модули, поэтому в бандле только `require("@opencode/plugin/gui")`
и `require("effect")` — никаких зависимостей и сборки не нужно.

Контракт хоста, на который опирается плагин (проверено по бандлу клиента 2.3.0):

- записи списка — `button[data-slot="sidebar-inbox-item"]`, `data-status` =
  `working | approval | input | failed | done | ready`;
- шапка сайдбара — `[data-slot="sidebar-header"]` (Home + кнопка сворачивания
  `button[aria-controls="vertical-tabs-sidebar"]`); сюда же session-timestamps и
  llama-swap переносят свои иконки;
- `TitlebarItem` в этой раскладке рендерится в `[data-slot="vertical-tabs-footer"]`;
- `Style` вставляет CSS в документ, пока плагин активен.

## Установка

Плагин — один CommonJS-файл без зависимостей и сборки, поэтому подключается
прямо из репозитория:

```bash
git clone https://github.com/Realmagnum/opencode-inbox-compact ~/plugins/opencode-inbox-compact
```

Путь в `plugins` должен быть абсолютным, без `~`:

```json
{
  "plugins": ["/Users/<you>/plugins/opencode-inbox-compact"]
}
```

GUI-часть читается только из `opencode.json(c)`. Проверка, что сервер видит
GUI-часть (сервис Desktop, пароль — `~/.config/opencode/service.json`):

```bash
PW=$(node -e 'console.log(require(process.env.HOME+"/.config/opencode/service.json").password)')
curl -s -u "opencode:$PW" http://127.0.0.1:49374/api/plugin \
  | python3 -c "import json,sys;[print(p['id'],p['features'],p['state']) for p in json.load(sys.stdin)['data'] if p['id']=='opencode-inbox-compact']"
# opencode-inbox-compact {'gui': True} {'status': 'active'}

curl -s -u "opencode:$PW" -G http://127.0.0.1:49374/api/plugin/gui \
  --data-urlencode "id=opencode-inbox-compact" \
  --data-urlencode "location[directory]=$PWD" | grep -c grid-template-columns
# 1
```

Серверная часть у плагина отсутствует намеренно: пакет без `"."`-экспорта — это
поддерживаемый вариант «только GUI».

## Как включить и выключить

1. Settings → Preferences → **Interface layout** → **Inbox**.
2. В шапке сайдбара, в ряду иконок плагинов (часы session-timestamps, пилюля
   llama-swap), появляется иконка `Compact list`; клик переключает режим
   (подсвеченная иконка — компактно, приглушённая — обычные строки).
3. Состояние сохраняется; при следующем запуске применяется автоматически.

Полностью отключить — убрать путь из `plugins` в `~/.config/opencode/opencode.json`.

## Тесты

```bash
node test/unit.mjs
```

Проверки идут офлайн, без сервера: подменяют `@opencode/plugin/gui` и `effect`,
поднимают минимальный фейковый DOM (дерево, селекторы, MutationObserver) и
прогоняют `setup` с фейковым контекстом.

## Проверка на живом клиенте

Разметка строки снята с работающего клиента (сервис Desktop :49374, веб-клиент
того же сервиса, раскладка Inbox, 18 записей): во второй строке ровно две
группы — `span.flex-1` (проект/ветка) и `span.ms-auto` (статус + время).
Шапка сайдбара — `[data-slot="sidebar-header"]` с Home в конце и кнопкой
сворачивания `button[aria-controls="vertical-tabs-sidebar"]`; иконки плагинов
вставляются прямо перед ней.

Ожидаемое поведение после `Cmd + R`:

| Состояние | Высота записи | Вторая строка | Статус и время |
|---|---|---|---|
| выключено | 54 px | видна | на месте |
| включено | 24 px | проект/ветка скрыты | на месте (точка/ring + `49m`) |
