# Changelog

## [0.16.0](https://github.com/utensils/claudette/compare/v0.15.0...v0.16.0) (2026-04-21)


### Features

* **chat:** Phase 3 — compaction detection and timeline divider ([#321](https://github.com/utensils/claudette/issues/321)) ([934a793](https://github.com/utensils/claudette/commit/934a793ec120f16d7504a456529190e04b935d36))
* context window tracking, phase 1 — token usage plumbing (refs [#300](https://github.com/utensils/claudette/issues/300)) ([#311](https://github.com/utensils/claudette/issues/311)) ([f624b42](https://github.com/utensils/claudette/commit/f624b42678b8bddd46d9fe852bea65c9b0f0155f))
* context window tracking, phase 2 — utilization meter (refs [#300](https://github.com/utensils/claudette/issues/300)) ([#315](https://github.com/utensils/claudette/issues/315)) ([e394ce5](https://github.com/utensils/claudette/commit/e394ce5d307fb8da0e0f1724e887b90c6f5fb24c))
* **metrics:** capture agent sessions, commits, and deleted-workspace summaries ([#283](https://github.com/utensils/claudette/issues/283)) ([a0e9ae0](https://github.com/utensils/claudette/commit/a0e9ae06b9d4d72081a3481c91ad80c37fd9d058))
* **scm:** auto-archive notifications and per-repo settings ([#297](https://github.com/utensils/claudette/issues/297)) ([60889f2](https://github.com/utensils/claudette/commit/60889f232d15ea3e845a9c95a6ff31351840eb62))
* **ui:** canonical design-system migration ([#320](https://github.com/utensils/claudette/issues/320)) ([d9f7c09](https://github.com/utensils/claudette/commit/d9f7c09236e33c534b4ff3e832ca738a43ea8935))


### Bug Fixes

* **chat:** keep thinking block visible through typewriter drain ([#318](https://github.com/utensils/claudette/issues/318)) ([b342e83](https://github.com/utensils/claudette/commit/b342e832d4fcc79e7b5d32b25a61a4ceeb209e93))
* context meter uses per-call usage, not turn aggregate (refs [#300](https://github.com/utensils/claudette/issues/300)) ([#317](https://github.com/utensils/claudette/issues/317)) ([b7a2f14](https://github.com/utensils/claudette/commit/b7a2f146935882296d2b857de4f42752ebf60255))
* **permissions:** auto-allow stray control_request in bypass mode ([#319](https://github.com/utensils/claudette/issues/319)) ([52d39a9](https://github.com/utensils/claudette/commit/52d39a9d52c6a6e368d46412d41dbd3bf977a120))
* **ui:** use shadow token for Toast to satisfy design-system check ([#330](https://github.com/utensils/claudette/issues/330)) ([ffcba14](https://github.com/utensils/claudette/commit/ffcba1488320ff332812752b7b2702989e37ccd5))

## [0.15.0](https://github.com/utensils/claudette/compare/v0.14.0...v0.15.0) (2026-04-20)


### Features

* **sidebar:** group by SCM status and filter by repo ([#301](https://github.com/utensils/claudette/issues/301)) ([c2ce309](https://github.com/utensils/claudette/commit/c2ce3093613b0846d374556954960985954a57c3))
* **updater:** add stable/nightly update channel toggle ([#307](https://github.com/utensils/claudette/issues/307)) ([6508014](https://github.com/utensils/claudette/commit/65080141327b54a87635ea11064484ae2a3e2c75))


### Bug Fixes

* **git:** support local-only repos without a remote ([#295](https://github.com/utensils/claudette/issues/295)) ([1fd7de1](https://github.com/utensils/claudette/commit/1fd7de169b2f105ec3f33843ae9328910ca02970))
* **sidebar:** show empty state when status grouping renders nothing ([#310](https://github.com/utensils/claudette/issues/310)) ([8291688](https://github.com/utensils/claudette/commit/829168876e45368b3ee17e673ca2b04bac431165))
* **ui:** match dropdown height to text input height ([#309](https://github.com/utensils/claudette/issues/309)) ([1e147a2](https://github.com/utensils/claudette/commit/1e147a2d1b55c08913d22aa962dfede24426aeb1))

## [0.14.0](https://github.com/utensils/claudette/compare/v0.13.1...v0.14.0) (2026-04-19)


### Features

* **chat:** apply typewriter-style streaming reveal to thinking blocks ([#296](https://github.com/utensils/claudette/issues/296)) ([0af15d8](https://github.com/utensils/claudette/commit/0af15d841cfc8864e42ddfc81e9d2c83580f7505))
* **chat:** typewriter-style streaming reveal for assistant messages ([#291](https://github.com/utensils/claudette/issues/291)) ([02b6f90](https://github.com/utensils/claudette/commit/02b6f90432458275cda19b7a264d91c534d7c48d))
* **ci:** add nightly build workflow for continuous pre-release artifacts ([#294](https://github.com/utensils/claudette/issues/294)) ([bf851c5](https://github.com/utensils/claudette/commit/bf851c598bce183178fa2482c2a0e89d2053d530))
* New default themes ([#289](https://github.com/utensils/claudette/issues/289)) ([8bbc9df](https://github.com/utensils/claudette/commit/8bbc9df2b303b61b4247376cd195e68a7cf2087a))


### Bug Fixes

* **site:** use lowercase /claudette/ base path for internal URLs ([#292](https://github.com/utensils/claudette/issues/292)) ([f2d485a](https://github.com/utensils/claudette/commit/f2d485af047b98ebd48015bd15bde562906d1266))
* **ui:** remove stale macOS left padding from diff viewer header ([#298](https://github.com/utensils/claudette/issues/298)) ([a6046f3](https://github.com/utensils/claudette/commit/a6046f30b831883f5114aa9a27ca1d080ddc9f73))

## [0.13.1](https://github.com/utensils/claudette/compare/v0.13.0...v0.13.1) (2026-04-18)


### Bug Fixes

* **chat:** force session teardown after ExitPlanMode ([#285](https://github.com/utensils/claudette/issues/285)) ([ce3844b](https://github.com/utensils/claudette/commit/ce3844b76afcb961924f58ac6e2c30105caa43d9))
* **chat:** round-trip AskUserQuestion / ExitPlanMode via control_response ([#271](https://github.com/utensils/claudette/issues/271)) ([809b9d3](https://github.com/utensils/claudette/commit/809b9d3645612daddcd281870e08da800c5845c6))
* **scm:** use enriched PATH so plugins find gh/glab in release builds ([#287](https://github.com/utensils/claudette/issues/287)) ([d57c706](https://github.com/utensils/claudette/commit/d57c70657c56e6c0b6b10cf7c8ff21aa64b6e918))

## [0.13.0](https://github.com/utensils/claudette/compare/v0.12.0...v0.13.0) (2026-04-18)


### Features

* **chat:** per-turn footer with elapsed, copy, fork, and rollback ([#277](https://github.com/utensils/claudette/issues/277)) ([55a8ec2](https://github.com/utensils/claudette/commit/55a8ec20702f58f592401937c4a3c370da21b99b))
* SCM provider plugins, git-status file groups, and PR status UI ([#238](https://github.com/utensils/claudette/issues/238)) ([7ca9145](https://github.com/utensils/claudette/commit/7ca91459c4273779a8949deae5a9f721670e7fd2))


### Bug Fixes

* **ui:** remove visible gap between left sidebar and main panel ([#276](https://github.com/utensils/claudette/issues/276)) ([13d0ff8](https://github.com/utensils/claudette/commit/13d0ff815e1f64b2c084004a136d89331662c31c))

## [0.12.0](https://github.com/utensils/claudette/compare/v0.11.0...v0.12.0) (2026-04-17)


### Features

* **ui:** add "More" disclosure for older models in picker ([#255](https://github.com/utensils/claudette/issues/255)) ([ee90681](https://github.com/utensils/claudette/commit/ee90681ff9d27ffcd061161aadd32ac9eeb1f10f))
* **ui:** simplify chat header and unify send/stop button ([#266](https://github.com/utensils/claudette/issues/266)) ([a301ca4](https://github.com/utensils/claudette/commit/a301ca49b6e86d6637f7fc8080690debe1231427))
* **ui:** use sidebar status icons on dashboard cards ([#265](https://github.com/utensils/claudette/issues/265)) ([9f98997](https://github.com/utensils/claudette/commit/9f989975380a9454f7d780e37871160232d7159c))


### Bug Fixes

* **agent:** respawn persistent session when plan_mode or allowedTools drift ([#264](https://github.com/utensils/claudette/issues/264)) ([4dc7c31](https://github.com/utensils/claudette/commit/4dc7c31dcfbfec61508684c1a88ae73a073c68e1))
* **sidebar:** prevent double-click race conditions on archive/restore ([#270](https://github.com/utensils/claudette/issues/270)) ([93368a8](https://github.com/utensils/claudette/commit/93368a87705fe111fd33662cdec4645606d60d06))
* **terminal:** prevent command buffer clearing before extraction ([#272](https://github.com/utensils/claudette/issues/272)) ([5bcc6f4](https://github.com/utensils/claudette/commit/5bcc6f45a23144922a3818ca7c367088c88ce520))
* **ui:** apply default plan mode regardless of thinking/fast defaults ([#267](https://github.com/utensils/claudette/issues/267)) ([f1adb5f](https://github.com/utensils/claudette/commit/f1adb5fccebf2dd233b36dc63e378210207407e7))
* **ui:** make chat toolbar chips respect UI font size ([#262](https://github.com/utensils/claudette/issues/262)) ([2038903](https://github.com/utensils/claudette/commit/203890377083248524c76792731aacd14f7c6a72))
* **ui:** redistribute Rosé Pine colors across the full palette ([#263](https://github.com/utensils/claudette/issues/263)) ([dd602f4](https://github.com/utensils/claudette/commit/dd602f494fbb2d8715ebc951d774e111d2831a6a))

## [0.11.0](https://github.com/utensils/claudette/compare/v0.10.0...v0.11.0) (2026-04-17)


### ⚠ BREAKING CHANGES

* Notification command env vars CLAUDETTE_NOTIFICATION_TITLE and CLAUDETTE_NOTIFICATION_BODY are removed, replaced by the 6 standard workspace env vars.

### Features

* add CLAUDETTE_* environment variables to all subprocesses ([#227](https://github.com/utensils/claudette/issues/227)) ([2985a7e](https://github.com/utensils/claudette/commit/2985a7ebdf9db78f3cba60ff26b1062674f7fa70))
* **chat:** /init and /help native slash commands ([#254](https://github.com/utensils/claudette/issues/254)) ([a3de6e0](https://github.com/utensils/claudette/commit/a3de6e0d03572a6e93908d57b60bdd4edd0d78f1))
* **chat:** add /config, /usage, /extra-usage, /release-notes, /version commands ([#252](https://github.com/utensils/claudette/issues/252)) ([b0bd90f](https://github.com/utensils/claudette/commit/b0bd90fc042dba2921ae8d8d10e7cebd3ba30a0a))
* **chat:** add /review, /security-review, /pr-comments native slash commands ([#250](https://github.com/utensils/claudette/issues/250)) ([2fd8aa4](https://github.com/utensils/claudette/commit/2fd8aa43867d5a96eff9fef8034181fe3618a4b2))
* **chat:** add native /clear, /plan, /model, /permissions, /status ([#251](https://github.com/utensils/claudette/issues/251)) ([7e7ccca](https://github.com/utensils/claudette/commit/7e7cccafec53d2827bea6264e98634676f9fdfde))
* **chat:** native slash command framework with aliases and kinds ([#248](https://github.com/utensils/claudette/issues/248)) ([77f7b13](https://github.com/utensils/claudette/commit/77f7b13b901544090eb74a2691213530bad4a4cc))
* **chat:** remove access dropdown from header ([#256](https://github.com/utensils/claudette/issues/256)) ([457459f](https://github.com/utensils/claudette/commit/457459fb41a8d1a4c2a85acb128025a33cf763c6))
* discover and import existing git worktrees when adding repos ([#253](https://github.com/utensils/claudette/issues/253)) ([89b73ba](https://github.com/utensils/claudette/commit/89b73baf17b120f109289ccfba70f536056487f3))
* **mcp:** add MCP server supervision with persistent sessions and connectors UI ([#194](https://github.com/utensils/claudette/issues/194)) ([dbc80e1](https://github.com/utensils/claudette/commit/dbc80e12b9b628b28df03ec1407a2aa5097ffabc))
* **plugins:** add Claude Code plugin management ([#234](https://github.com/utensils/claudette/issues/234)) ([56b580e](https://github.com/utensils/claudette/commit/56b580e64921129337d9e26d85304e6f26837eec))
* **sidebar:** add remote filter and fix remote section spacing ([#228](https://github.com/utensils/claudette/issues/228)) ([38e3894](https://github.com/utensils/claudette/commit/38e389434112ba2207a90fe096e752259d85922e))
* **sidebar:** replace workspace filter buttons with compact dropdown menu ([#229](https://github.com/utensils/claudette/issues/229)) ([5b1c0c6](https://github.com/utensils/claudette/commit/5b1c0c6faf21423499b16d7682b915d1e8f07d5d))
* stepwise agent question wizard for multi-question flows ([#200](https://github.com/utensils/claudette/issues/200)) ([01f7b1b](https://github.com/utensils/claudette/commit/01f7b1b4e2e2a8cc2ad728ecdf7236c5b1a2663a))
* **tray:** light, dark, and color icon variants with user preference ([#214](https://github.com/utensils/claudette/issues/214)) ([593cfdf](https://github.com/utensils/claudette/commit/593cfdf586b9c2bc88618a59dae9750a542c2002))
* **ui:** add Claude Opus 4.7 to model selectors ([#240](https://github.com/utensils/claudette/issues/240)) ([083ecae](https://github.com/utensils/claudette/commit/083ecae7aaa2bf1716b9817c4c284cf3ee493a1a))
* **ui:** Brink theme, WCAG theme fixes, font customization, and zoom shortcuts ([#215](https://github.com/utensils/claudette/issues/215)) ([#218](https://github.com/utensils/claudette/issues/218)) ([bc2cdd4](https://github.com/utensils/claudette/commit/bc2cdd45e3888ff2604ef2fffa3cc20c994ff386))
* **ui:** move dashboard button to sidebar and remove chat header left padding ([b1e6833](https://github.com/utensils/claudette/commit/b1e6833ec830b0cc11e70007eed40e4c84516c0a))


### Bug Fixes

* add macOS updater artifacts and check-for-updates button ([#202](https://github.com/utensils/claudette/issues/202)) ([a7e6ab3](https://github.com/utensils/claudette/commit/a7e6ab3d81f3833a04be95a2c039f9adf00f56a0))
* **chat:** default completed turns to collapsed ([#205](https://github.com/utensils/claudette/issues/205)) ([bb4ca63](https://github.com/utensils/claudette/commit/bb4ca6323a7642ddd439d2a7525c158019913ada))
* **chat:** keep WorkspaceActions dropdown enabled during agent runs ([#220](https://github.com/utensils/claudette/issues/220)) ([5587fc4](https://github.com/utensils/claudette/commit/5587fc46512222d7803df9f8938f9608ff9bd6d0)), closes [#219](https://github.com/utensils/claudette/issues/219)
* **chat:** open links in system browser instead of navigating webview ([#221](https://github.com/utensils/claudette/issues/221)) ([a2d220e](https://github.com/utensils/claudette/commit/a2d220ea076f72dc2fb7fb95ad62536d7de985c1))
* **chat:** tone down completed progress bar brightness ([#222](https://github.com/utensils/claudette/issues/222)) ([2717d66](https://github.com/utensils/claudette/commit/2717d66c6467165f3dd7f46001218b2b102aa0bd)), closes [#183](https://github.com/utensils/claudette/issues/183)
* **ci:** stage flake.nix before git pull --rebase in Nix hash workflow ([#203](https://github.com/utensils/claudette/issues/203)) ([8eed425](https://github.com/utensils/claudette/commit/8eed4259591a1b330cfa2913442279cf2b8be7b2))
* **ci:** use PAT for Nix hash workflow to bypass branch ruleset ([#209](https://github.com/utensils/claudette/issues/209)) ([9d85f85](https://github.com/utensils/claudette/commit/9d85f85f79d2307976e1152fd12400c11ebc9852))
* **ci:** use PR with auto-merge for Nix FOD hash updates ([#206](https://github.com/utensils/claudette/issues/206)) ([c3714ed](https://github.com/utensils/claudette/commit/c3714ed434c322345fd93506a6adf409d3e18fad))
* **debug:** correct agent status reporting in debug skill ([#233](https://github.com/utensils/claudette/issues/233)) ([618df3c](https://github.com/utensils/claudette/commit/618df3cd18532fc6122cf5a411c60b9b65f92aa5))
* **env:** enrich PATH for subprocesses launched from Finder ([#230](https://github.com/utensils/claudette/issues/230)) ([25d8136](https://github.com/utensils/claudette/commit/25d81362c9fd49995461b930e6a466556f7202d7))
* **git:** fetch remote before worktree creation and add setup script auto-run ([#224](https://github.com/utensils/claudette/issues/224)) ([1d400ec](https://github.com/utensils/claudette/commit/1d400ec7c09bc67f679dbfe2824d70dac03b05a3))
* kill embedded server process on app exit to prevent port conflicts ([#204](https://github.com/utensils/claudette/issues/204)) ([44e433f](https://github.com/utensils/claudette/commit/44e433fe5bbfec283f85b588928120a60ae4f55a))
* **mcp:** defer MCP config restart to next turn boundary ([#232](https://github.com/utensils/claudette/issues/232)) ([cd0184f](https://github.com/utensils/claudette/commit/cd0184f1cdc50a01f883704ce9c6e154e9f20ac5))
* **terminal:** overhaul lifecycle, keybindings, and focus flow ([#212](https://github.com/utensils/claudette/issues/212)) ([a900bb9](https://github.com/utensils/claudette/commit/a900bb9ab2a25595504237e084c5453511837a40))
* **terminal:** prevent command concatenation in workspace panel display ([#225](https://github.com/utensils/claudette/issues/225)) ([12f1d53](https://github.com/utensils/claudette/commit/12f1d538acf1b5584951b8027ef67b3cf73f8ec6))
* **terminal:** set TERM=xterm-256color in PTY environment ([#223](https://github.com/utensils/claudette/issues/223)) ([e8ff747](https://github.com/utensils/claudette/commit/e8ff7476cbd60aed82a483652a231a7380c07c7a))
* **ui:** keep workspace mounted when settings are open ([#236](https://github.com/utensils/claudette/issues/236)) ([562c427](https://github.com/utensils/claudette/commit/562c427c206933e41c8dfd30c14126be3a72689a))
* **ui:** remove MCP status indicator from sidebar ([#258](https://github.com/utensils/claudette/issues/258)) ([44b3011](https://github.com/utensils/claudette/commit/44b3011bce26880e383b9e8ff08ee8ca95536cfd))

## [0.10.0](https://github.com/utensils/claudette/compare/v0.9.0...v0.10.0) (2026-04-15)


### Features

* make terminal panel colors reflect active theme ([#196](https://github.com/utensils/claudette/issues/196)) ([b10a41b](https://github.com/utensils/claudette/commit/b10a41b9e5d2484312d16d8b3b7ff3fe7ff93012))
* replace sidebar status dot with braille spinner for running workspaces ([#198](https://github.com/utensils/claudette/issues/198)) ([a7fd34c](https://github.com/utensils/claudette/commit/a7fd34ca4c58f56bb75ad246704016c29c5df5bf))


### Bug Fixes

* lowercase base path to match GitHub Pages serving path ([#197](https://github.com/utensils/claudette/issues/197)) ([5b456ba](https://github.com/utensils/claudette/commit/5b456babfdc16acafbd5762ca4bb0cc31e1d54e6))
* normalize MCP configs to include required 'type' field ([#191](https://github.com/utensils/claudette/issues/191)) ([c85baa4](https://github.com/utensils/claudette/commit/c85baa4a491e18855b020fb033e5883d28a759df))
* pass MCP config on every turn, not just first turn ([#193](https://github.com/utensils/claudette/issues/193)) ([ef2900d](https://github.com/utensils/claudette/commit/ef2900db6193f3726c6820464a865d7eab273617))

## [0.9.0](https://github.com/utensils/Claudette/compare/v0.8.0...v0.9.0) (2026-04-14)


### Features

* add --chrome flag support for browser automation ([#169](https://github.com/utensils/Claudette/issues/169)) ([b46cb16](https://github.com/utensils/Claudette/commit/b46cb1627708544eb52497644112f7218869c106))
* add agent task tracking UI with right sidebar tabs ([#162](https://github.com/utensils/Claudette/issues/162)) ([caa50db](https://github.com/utensils/Claudette/commit/caa50dbb2496bdaead4659f290222492738eb249))
* add Claude Code usage display for Pro/Max subscribers ([#172](https://github.com/utensils/Claudette/issues/172)) ([a045921](https://github.com/utensils/Claudette/commit/a045921f713c71bebc91cd2ff525446757bd91be))
* auto-detect installed apps for workspace actions ([#159](https://github.com/utensils/Claudette/issues/159)) ([fc4bd6f](https://github.com/utensils/Claudette/commit/fc4bd6fb99958f0c22332d1b6d9d53b55e261af8))
* highlight chat input with dashed border when plan mode is active ([#160](https://github.com/utensils/Claudette/issues/160)) ([303727a](https://github.com/utensils/Claudette/commit/303727a11abe724acd4b51d00d1581d5beb96958))
* implement MCP configuration detection and --mcp-config injection ([#177](https://github.com/utensils/Claudette/issues/177)) ([8d21a36](https://github.com/utensils/Claudette/commit/8d21a3629c37c4f9f55a506d1aa0b8058a566704))
* render plan approval content as rich markdown ([#176](https://github.com/utensils/Claudette/issues/176)) ([23291d7](https://github.com/utensils/Claudette/commit/23291d73716049ac7831499301b785e60298eca1))
* support image and PDF attachments in chat ([#137](https://github.com/utensils/Claudette/issues/137)) ([#182](https://github.com/utensils/Claudette/issues/182)) ([1fd294a](https://github.com/utensils/Claudette/commit/1fd294afb93dfc9d9334ba7f58b31ebe60f7cf15))
* UI polish — panel resize, sticky scroll, hotkey hints, streaming highlight ([#149](https://github.com/utensils/Claudette/issues/149)) ([f41db9b](https://github.com/utensils/Claudette/commit/f41db9b23cc8ba012173ce984b87536bcbafa227))
* **ui:** add brain icon to thinking block header ([#179](https://github.com/utensils/Claudette/issues/179)) ([8dc1586](https://github.com/utensils/Claudette/commit/8dc15864b798203eec504102fbd490b55368e6cd))
* **ui:** add themed attention badges to sidebar ([#165](https://github.com/utensils/Claudette/issues/165)) ([fd1ae71](https://github.com/utensils/Claudette/commit/fd1ae71c3f5208176a85804d30a1863f6797733e))


### Bug Fixes

* add end-of-options separator before branch names in git commands ([#167](https://github.com/utensils/Claudette/issues/167)) ([ecac000](https://github.com/utensils/Claudette/commit/ecac000a340f23ef9bf11af6f2f989f377f3e426))
* always force-delete branch on archive/delete ([#166](https://github.com/utensils/Claudette/issues/166)) ([91ac1e9](https://github.com/utensils/Claudette/commit/91ac1e9c9c6f81eb1230e6ad9f67efd0e72f640c))
* **chat:** reliable sticky scroll with MutationObserver ([#168](https://github.com/utensils/Claudette/issues/168)) ([79fee78](https://github.com/utensils/Claudette/commit/79fee78d96ef1fa2f33e33bf18394c4c10bda403))
* embed claudette-server into the Tauri binary ([#178](https://github.com/utensils/Claudette/issues/178)) ([e9f361b](https://github.com/utensils/Claudette/commit/e9f361b1633ab624536d8b32e951ec70f08daa7c))
* resolve claude CLI path for GUI-launched apps ([#181](https://github.com/utensils/Claudette/issues/181)) ([bbe2471](https://github.com/utensils/Claudette/commit/bbe247143b3a017616aac958628831d51ce55415))
* **ui:** enable window dragging for custom overlay titlebar ([#161](https://github.com/utensils/Claudette/issues/161)) ([232fdd6](https://github.com/utensils/Claudette/commit/232fdd6c8961dca4245656174690db174afa2334))

## [0.8.0](https://github.com/utensils/Claudette/compare/v0.7.0...v0.8.0) (2026-04-12)


### Features

* @-mention file references in chat input ([#153](https://github.com/utensils/Claudette/issues/153)) ([5de4edd](https://github.com/utensils/Claudette/commit/5de4edd59294cacadf7a48f1dca40d5b00b41136))
* add Astro Starlight documentation site ([#158](https://github.com/utensils/Claudette/issues/158)) ([df10113](https://github.com/utensils/Claudette/commit/df10113a094acf07bd00230daf1e003b45b858cb))
* **settings:** full-page settings view with new configuration options ([#155](https://github.com/utensils/Claudette/issues/155)) ([4ded233](https://github.com/utensils/Claudette/commit/4ded2335d74bb1a3cbedcfc059948ae5c57f21ad))
* **ui:** overlay titlebar and header panel toggle icons ([#157](https://github.com/utensils/Claudette/issues/157)) ([8e814bb](https://github.com/utensils/Claudette/commit/8e814bb98b64db172ce1a368453f542a5ab51885))


### Bug Fixes

* **ui:** replace ambiguous X icons with Archive and Trash2 in sidebar ([#156](https://github.com/utensils/Claudette/issues/156)) ([a3129b7](https://github.com/utensils/Claudette/commit/a3129b7bb8bbbd8147ea426f8f4721b0cd36d7f6))

## [0.7.0](https://github.com/utensils/Claudette/compare/v0.6.0...v0.7.0) (2026-04-12)


### Features

* system tray, notifications, keyboard hints, macOS window behavior, and UX polish ([#119](https://github.com/utensils/Claudette/issues/119)) ([e5fef65](https://github.com/utensils/Claudette/commit/e5fef6526417dee67d93d54022e85aa44bf86f8e))


### Bug Fixes

* skip updater checks in dev mode ([#151](https://github.com/utensils/Claudette/issues/151)) ([764904b](https://github.com/utensils/Claudette/commit/764904b2ec771f8a5ab8796dace72b2b2ca97135)), closes [#147](https://github.com/utensils/Claudette/issues/147)

## [0.6.0](https://github.com/utensils/Claudette/compare/v0.5.3...v0.6.0) (2026-04-11)


### Features

* add terminal command display via OSC 133 shell integration ([#132](https://github.com/utensils/Claudette/issues/132)) ([11948a1](https://github.com/utensils/Claudette/commit/11948a1193fea6f12d03c16873733b35f95b054d))
* auto-rename git branch after first user prompt using Haiku ([#135](https://github.com/utensils/Claudette/issues/135)) ([ec7e739](https://github.com/utensils/Claudette/commit/ec7e739f11c6447817cc26cb85b299fdc3f46bdd))
* effort level control + thinking block display ([#140](https://github.com/utensils/Claudette/issues/140)) ([37bd006](https://github.com/utensils/Claudette/commit/37bd006a4ac638fc83a05238f4eddbd75a70035e))


### Bug Fixes

* apply tool colors during streaming in ToolActivitiesSection ([#142](https://github.com/utensils/Claudette/issues/142)) ([f147ce5](https://github.com/utensils/Claudette/commit/f147ce5b4d2518bdff44f20a01dc08b90d91f053)), closes [#134](https://github.com/utensils/Claudette/issues/134)
* **build:** add macOS DMG bundle config for volume icon ([#141](https://github.com/utensils/Claudette/issues/141)) ([c17c385](https://github.com/utensils/Claudette/commit/c17c3859aa1bd77048611915c2bb0635fa9b21d5))
* rename branch from worktree path to avoid checked-out error ([#138](https://github.com/utensils/Claudette/issues/138)) ([c3e4a42](https://github.com/utensils/Claudette/commit/c3e4a4291db69fb37aca1e7c1a3a262b1943d20d))

## [0.5.3](https://github.com/utensils/Claudette/compare/v0.5.2...v0.5.3) (2026-04-11)


### Bug Fixes

* **build:** add platform-specific icons for macOS/Windows bundling ([#129](https://github.com/utensils/Claudette/issues/129)) ([ff1165a](https://github.com/utensils/Claudette/commit/ff1165af5be09b0d2c7aa32ec5540265c74a9a63))

## [0.5.2](https://github.com/utensils/Claudette/compare/v0.5.1...v0.5.2) (2026-04-10)


### Bug Fixes

* **ui:** add missing "general" to CommandCategory type ([#127](https://github.com/utensils/Claudette/issues/127)) ([5238e5a](https://github.com/utensils/Claudette/commit/5238e5ad3104de8df8a7b65ef4fb29e60391ff3f))

## [0.5.1](https://github.com/utensils/Claudette/compare/v0.5.0...v0.5.1) (2026-04-10)


### Bug Fixes

* **ci:** pin bun version to prevent lockfile drift ([#124](https://github.com/utensils/Claudette/issues/124)) ([005d940](https://github.com/utensils/Claudette/commit/005d940aaf3f6b4a43a278c9f7e7e9e9e9a8ed56))

## [0.5.0](https://github.com/utensils/Claudette/compare/v0.4.0...v0.5.0) (2026-04-10)


### Features

* add Nix flake with devshell and build targets ([#100](https://github.com/utensils/Claudette/issues/100)) ([198d882](https://github.com/utensils/Claudette/commit/198d882c94883aa8da91e224d5a20d1134f6bd20))
* add theme support with settings UI and community theme directory ([#60](https://github.com/utensils/Claudette/issues/60)) ([e8f3912](https://github.com/utensils/Claudette/commit/e8f3912ebd15acd8504f7e9879a303eda2ea54b1))
* agent completion notifications with visual badge and audio alert ([#80](https://github.com/utensils/Claudette/issues/80)) ([c835e5b](https://github.com/utensils/Claudette/commit/c835e5bf87b4bb222b683d62c52cab7db23890d4))
* agent session UX — resume, plan mode, question dialogs ([#113](https://github.com/utensils/Claudette/issues/113)) ([19104db](https://github.com/utensils/Claudette/commit/19104db8efbf366eb40f3f2ddc951d9a6c548cf7))
* archive remote workspaces from sidebar ([#87](https://github.com/utensils/Claudette/issues/87)) ([aef30cb](https://github.com/utensils/Claudette/commit/aef30cb633fa147fd96f09c048083435cbb8b927))
* auto-refresh changed files when agent stops ([#95](https://github.com/utensils/Claudette/issues/95)) ([3a7735b](https://github.com/utensils/Claudette/commit/3a7735b808028c78fdb243f0ff016b59ab8963c3))
* auto-resize chat input and preserve newlines in messages ([#90](https://github.com/utensils/Claudette/issues/90)) ([5330f55](https://github.com/utensils/Claudette/commit/5330f55559c24038b9c6ebd2bd928251df815478))
* collapse tool calls into summary during execution ([#92](https://github.com/utensils/Claudette/issues/92)) ([3bf44e9](https://github.com/utensils/Claudette/commit/3bf44e9b6f823109e4acafc202e187accb769fe7))
* conversation checkpoints, tool persistence, and UX polish ([#118](https://github.com/utensils/Claudette/issues/118)) ([ad3b383](https://github.com/utensils/Claudette/commit/ad3b383b9bb8fdf1e6a40fa063395f9a20b7c0b2))
* create remote workspaces from sidebar ([#84](https://github.com/utensils/Claudette/issues/84)) ([872b23a](https://github.com/utensils/Claudette/commit/872b23acd2ff22de7bb48debd8ec6f72a8a5b1c5))
* display current branch from worktree for all workspaces ([#89](https://github.com/utensils/Claudette/issues/89)) ([517890c](https://github.com/utensils/Claudette/commit/517890cced93fbd263b1f48dc99665781b28b68e))
* fix CI build and add auto-updater ([#117](https://github.com/utensils/Claudette/issues/117)) ([795f280](https://github.com/utensils/Claudette/commit/795f2801af4ed0b351c739a23c27794302a2c64a))
* remote workspace access via claudette-server and WebSocket transport ([#76](https://github.com/utensils/Claudette/issues/76)) ([0e875f7](https://github.com/utensils/Claudette/commit/0e875f733744381aafffbf2f2563d390c7076b4b))
* slash command autocomplete picker with dynamic discovery ([#81](https://github.com/utensils/Claudette/issues/81)) ([ace1b51](https://github.com/utensils/Claudette/commit/ace1b51e03c30877eaa7522afc9a1fffe7a1337f))
* sort slash command picker by usage frequency ([#82](https://github.com/utensils/Claudette/issues/82)) ([268721a](https://github.com/utensils/Claudette/commit/268721a48543c5b200c27bbcc9cd5b348859949d))
* standardize the lower left nav options as icons ([#85](https://github.com/utensils/Claudette/issues/85)) ([23f7aa4](https://github.com/utensils/Claudette/commit/23f7aa4ac7b0c71a2cd1df13bce4c819e5b7b2af))
* **ui:** chat polish, command palette, light theme, and theme-aware CSS ([#109](https://github.com/utensils/Claudette/issues/109)) ([1aa51ed](https://github.com/utensils/Claudette/commit/1aa51ed0c39dd6a60a19ce2ee69f0ad1fa3305f2))
* update app icon and favicon with new pig mascot ([#86](https://github.com/utensils/Claudette/issues/86)) ([dd89221](https://github.com/utensils/Claudette/commit/dd892218fffd410fad4bca1e04a44b0d56a570aa))


### Bug Fixes

* allow all tool commands with full permission level ([#105](https://github.com/utensils/Claudette/issues/105)) ([483570f](https://github.com/utensils/Claudette/commit/483570f9822dd2934a768f8058b48b4afa0dd877))
* chat activity and horizontal lines ([#101](https://github.com/utensils/Claudette/issues/101)) ([1e0ced9](https://github.com/utensils/Claudette/commit/1e0ced919fb53b8c8c4c6bfdc431444ce892f80f))
* eliminate 1-2 second typing lag in remote workspaces ([#78](https://github.com/utensils/Claudette/issues/78)) ([f88e58a](https://github.com/utensils/Claudette/commit/f88e58ad057fa4f7584a6ca48ef4974062af3ff9))
* ensure workspace deletion removes worktree directory from disk ([#114](https://github.com/utensils/Claudette/issues/114)) ([1afa7ca](https://github.com/utensils/Claudette/commit/1afa7ca7b3f9e7b865cccc074c2a0f66f502ed1e)), closes [#103](https://github.com/utensils/Claudette/issues/103)
* load diff files for remote workspaces ([#97](https://github.com/utensils/Claudette/issues/97)) ([6e96480](https://github.com/utensils/Claudette/commit/6e96480b045ed7af36217326bcccd1cc38abdffc))
* pass permission-mode on every agent turn ([#106](https://github.com/utensils/Claudette/issues/106)) ([a4fca26](https://github.com/utensils/Claudette/commit/a4fca26074848acd12c6dd72c45ff4818dcb7ecd))
* preserve terminal sessions when switching workspaces or tabs ([#112](https://github.com/utensils/Claudette/issues/112)) ([cacaaff](https://github.com/utensils/Claudette/commit/cacaafff5816f44ec3b1676be3b5dc0ac834809f))
* return branch-safe slug from generate_workspace_name ([#83](https://github.com/utensils/Claudette/issues/83)) ([02c87bf](https://github.com/utensils/Claudette/commit/02c87bf2c29c30d70563eb8d1e0911aec332b7ff))
* use remote-tracking refs for merge-base diff calculations ([#116](https://github.com/utensils/Claudette/issues/116)) ([59f576a](https://github.com/utensils/Claudette/commit/59f576a79508275eaea2b29c250f56a4c69144d1))
* use wildcard tool permissions for full level on remote server ([#107](https://github.com/utensils/Claudette/issues/107)) ([182e961](https://github.com/utensils/Claudette/commit/182e961eed53014a9d4debf648b51669cdd36d67))


### Performance Improvements

* minimize React re-renders across UI components ([#99](https://github.com/utensils/Claudette/issues/99)) ([ca3a4cf](https://github.com/utensils/Claudette/commit/ca3a4cf38d737a559e4e71e3b874303dda126057))

## [0.4.0](https://github.com/utensils/Claudette/compare/v0.3.0...v0.4.0) (2026-04-03)


### Features

* **ui:** comprehensive UI/UX overhaul with brand identity and polish ([#75](https://github.com/utensils/Claudette/issues/75)) ([dc35183](https://github.com/utensils/Claudette/commit/dc35183d759ee60f13b5c1cf2de5080e99c7daef))


### Bug Fixes

* **ci:** chain build jobs into release-please workflow ([#74](https://github.com/utensils/Claudette/issues/74)) ([d90b09d](https://github.com/utensils/Claudette/commit/d90b09d698e269cc4a363595ef013cbb9c0e11a0))
* terminal tabs persist across tab switches ([#71](https://github.com/utensils/Claudette/issues/71)) ([#72](https://github.com/utensils/Claudette/issues/72)) ([8239e4e](https://github.com/utensils/Claudette/commit/8239e4e08397df38c1b34b547ee4237fdd47b4e8))

## [0.3.0](https://github.com/utensils/Claudette/compare/v0.2.0...v0.3.0) (2026-04-02)


### Features

* add chat history controls ([#26](https://github.com/utensils/Claudette/issues/26)) ([a81bea3](https://github.com/utensils/Claudette/commit/a81bea34a66f2a16351eb96cb6b4e8688a002f81))
* add description to agent display ([#57](https://github.com/utensils/Claudette/issues/57)) ([0a46ebc](https://github.com/utensils/Claudette/commit/0a46ebcd2dbacc924abf942537e5bbc63d7cc4f1))
* add diff data layer and git diff operations ([#16](https://github.com/utensils/Claudette/issues/16)) ([#17](https://github.com/utensils/Claudette/issues/17)) ([ae080b3](https://github.com/utensils/Claudette/commit/ae080b37fa9c807a63a8f61bca78995bccc6cda5))
* add integrated terminal with alacritty backend and tab multiplexing ([#24](https://github.com/utensils/Claudette/issues/24)) ([442197e](https://github.com/utensils/Claudette/commit/442197e8a86bca51f6c9148d8eeb0d4a537698c8))
* add interactive popup for agent AskUserQuestion tool calls ([#47](https://github.com/utensils/Claudette/issues/47)) ([17b7a33](https://github.com/utensils/Claudette/commit/17b7a33a946f607b73d22b8de217adcd7cea38cc))
* add permission level to agent chat ([#40](https://github.com/utensils/Claudette/issues/40)) ([01443a3](https://github.com/utensils/Claudette/commit/01443a35a3badf35ad2df1fd474baeb37db2bc78))
* add project logo to README and as app window icon ([#14](https://github.com/utensils/Claudette/issues/14)) ([b6b2677](https://github.com/utensils/Claudette/commit/b6b2677c6df664b95b754d8bc7a311fea95c5c8e))
* add repository removal with confirmation modal and full cleanup ([#30](https://github.com/utensils/Claudette/issues/30)) ([005e75e](https://github.com/utensils/Claudette/commit/005e75e94abbfd56536fc5b307e7fc0d6ae13e6c))
* add settings UI with repo name/icon editing and worktree base config ([#23](https://github.com/utensils/Claudette/issues/23)) ([65b0c59](https://github.com/utensils/Claudette/commit/65b0c591ce35c4dcaab8ca12fce2836a4ad7a676))
* add sidebar/terminal resize + workspace actions ([#49](https://github.com/utensils/Claudette/issues/49)) ([716b986](https://github.com/utensils/Claudette/commit/716b986f4783d940a08bc821459de786dfd94a60))
* agent chat interface with streaming and persistence ([#15](https://github.com/utensils/Claudette/issues/15)) ([ee373cb](https://github.com/utensils/Claudette/commit/ee373cb32f30861b72637388c587acc2e1f803ec))
* allow browing filesystem when adding repos ([#42](https://github.com/utensils/Claudette/issues/42)) ([a2d7156](https://github.com/utensils/Claudette/commit/a2d71567c04add2543ecc858cca95f3e64233b0b))
* allow resizing vertical and horizontal panes ([95bbbe6](https://github.com/utensils/Claudette/commit/95bbbe6f7be94a39930ad63c839a8222f7755dd9))
* auto start tab when opening terminal pane ([#39](https://github.com/utensils/Claudette/issues/39)) ([572d56e](https://github.com/utensils/Claudette/commit/572d56e084ecd87c31652e829c7595ce312cd754))
* braille spinner and elapsed timer in agent chat ([#61](https://github.com/utensils/Claudette/issues/61)) ([58c42c1](https://github.com/utensils/Claudette/commit/58c42c1b7cf958054ac1bfe2bf225545230ed722))
* configurable terminal font size ([#62](https://github.com/utensils/Claudette/issues/62)) ([e16cee9](https://github.com/utensils/Claudette/commit/e16cee99ba18818e6422cfbc964e4a9826e4a29e))
* dashboard navigation and shared repo icons ([#66](https://github.com/utensils/Claudette/issues/66)) ([95c5aa5](https://github.com/utensils/Claudette/commit/95c5aa5e9912ae13373c1285538bc45f3a36be1c))
* diff viewer UI with file tree and side-by-side views ([#18](https://github.com/utensils/Claudette/issues/18)) ([d9bcdbe](https://github.com/utensils/Claudette/commit/d9bcdbeb8026aa08d6ce68040f04bbae7fc4cf40))
* per-repo custom instructions for agent chat ([#70](https://github.com/utensils/Claudette/issues/70)) ([5423cf5](https://github.com/utensils/Claudette/commit/5423cf5cba96b6ece056fcbdc16726807b9a0e46))
* render Lucide icons for repos in sidebar ([#64](https://github.com/utensils/Claudette/issues/64)) ([9b6f1c9](https://github.com/utensils/Claudette/commit/9b6f1c9d1049ad042b27b1910e108ca2f0359d8a))
* scaffold Rust + Iced boilerplate project ([#1](https://github.com/utensils/Claudette/issues/1)) ([43377f6](https://github.com/utensils/Claudette/commit/43377f60ac6be5239bcfa675215e527c433115b3))
* setup scripts for workspace creation ([#50](https://github.com/utensils/Claudette/issues/50)) ([#53](https://github.com/utensils/Claudette/issues/53)) ([ff0d854](https://github.com/utensils/Claudette/commit/ff0d85461df05c14b82521d139f3c8d8fe996be4))
* show repo/branch info in chat header ([#59](https://github.com/utensils/Claudette/issues/59)) ([dbdc70a](https://github.com/utensils/Claudette/commit/dbdc70a030503aaa8dfbb7eaea917c54a376c4ac))
* subscribe to brnach name changes, update sidebar ([#32](https://github.com/utensils/Claudette/issues/32)) ([fb4f37a](https://github.com/utensils/Claudette/commit/fb4f37a7a82384fde0bbaf24a195b0b77513d896))
* tool call summaries and rollup ([#51](https://github.com/utensils/Claudette/issues/51)) ([511c17a](https://github.com/utensils/Claudette/commit/511c17a4ca67a95d90065b6fca036cd04a6968df))
* workspace dashboard with last message preview ([#63](https://github.com/utensils/Claudette/issues/63)) ([fb5126f](https://github.com/utensils/Claudette/commit/fb5126faf9fd9e764d3208767a952784ebf587df))
* workspace management with SQLite and git worktree integration ([#9](https://github.com/utensils/Claudette/issues/9)) ([83f8be7](https://github.com/utensils/Claudette/commit/83f8be7f6563a3d6005d6def88f6ea9d3ec5c796))


### Bug Fixes

* add fix for termianl start back ([#33](https://github.com/utensils/Claudette/issues/33)) ([ef24b5f](https://github.com/utensils/Claudette/commit/ef24b5f4de51df0489b537c6328d3ae33c6b3bd5))
* add macOS SDK library path for libiconv linking ([#10](https://github.com/utensils/Claudette/issues/10)) ([2749466](https://github.com/utensils/Claudette/commit/27494668a381b5e95ab14f65e45bdc4eb6f940bb))
* focus between chat prompt and terminal ([#28](https://github.com/utensils/Claudette/issues/28)) ([7532ae0](https://github.com/utensils/Claudette/commit/7532ae073a19af54e5437e64e7f7b1043b5d4495))
* make permissions select dark style ([#43](https://github.com/utensils/Claudette/issues/43)) ([a46f841](https://github.com/utensils/Claudette/commit/a46f8415351f1a544acf171a5bf4128d5baec59f))
* rewrite agent pane with per-turn process spawning ([#27](https://github.com/utensils/Claudette/issues/27)) ([6cf729a](https://github.com/utensils/Claudette/commit/6cf729a17f6a16547af8939877430f35edcfa84c))
* show checked out branch on load ([#41](https://github.com/utensils/Claudette/issues/41)) ([565ddc1](https://github.com/utensils/Claudette/commit/565ddc1fa23191a956cf750ca48135eddc172cca))
* solve Invalid API Key warning in chat pane ([#34](https://github.com/utensils/Claudette/issues/34)) ([9a696d6](https://github.com/utensils/Claudette/commit/9a696d6bcc75e2f5e330ea5d37d961a7f5c0a067))
* update readme with tauri changes ([#44](https://github.com/utensils/Claudette/issues/44)) ([9c3824c](https://github.com/utensils/Claudette/commit/9c3824cbe7a2d9c58f954c0ce7db92cdaab5b78c))
* use simple v* tag format for release-please ([#68](https://github.com/utensils/Claudette/issues/68)) ([2d61e55](https://github.com/utensils/Claudette/commit/2d61e5503335e1d404d29d8650f03cd1ffd4cac9))

## [0.2.0](https://github.com/utensils/Claudette/compare/claudette-v0.1.0...claudette-v0.2.0) (2026-04-02)


### Features

* add chat history controls ([#26](https://github.com/utensils/Claudette/issues/26)) ([a81bea3](https://github.com/utensils/Claudette/commit/a81bea34a66f2a16351eb96cb6b4e8688a002f81))
* add description to agent display ([#57](https://github.com/utensils/Claudette/issues/57)) ([0a46ebc](https://github.com/utensils/Claudette/commit/0a46ebcd2dbacc924abf942537e5bbc63d7cc4f1))
* add diff data layer and git diff operations ([#16](https://github.com/utensils/Claudette/issues/16)) ([#17](https://github.com/utensils/Claudette/issues/17)) ([ae080b3](https://github.com/utensils/Claudette/commit/ae080b37fa9c807a63a8f61bca78995bccc6cda5))
* add integrated terminal with alacritty backend and tab multiplexing ([#24](https://github.com/utensils/Claudette/issues/24)) ([442197e](https://github.com/utensils/Claudette/commit/442197e8a86bca51f6c9148d8eeb0d4a537698c8))
* add interactive popup for agent AskUserQuestion tool calls ([#47](https://github.com/utensils/Claudette/issues/47)) ([17b7a33](https://github.com/utensils/Claudette/commit/17b7a33a946f607b73d22b8de217adcd7cea38cc))
* add permission level to agent chat ([#40](https://github.com/utensils/Claudette/issues/40)) ([01443a3](https://github.com/utensils/Claudette/commit/01443a35a3badf35ad2df1fd474baeb37db2bc78))
* add project logo to README and as app window icon ([#14](https://github.com/utensils/Claudette/issues/14)) ([b6b2677](https://github.com/utensils/Claudette/commit/b6b2677c6df664b95b754d8bc7a311fea95c5c8e))
* add repository removal with confirmation modal and full cleanup ([#30](https://github.com/utensils/Claudette/issues/30)) ([005e75e](https://github.com/utensils/Claudette/commit/005e75e94abbfd56536fc5b307e7fc0d6ae13e6c))
* add settings UI with repo name/icon editing and worktree base config ([#23](https://github.com/utensils/Claudette/issues/23)) ([65b0c59](https://github.com/utensils/Claudette/commit/65b0c591ce35c4dcaab8ca12fce2836a4ad7a676))
* add sidebar/terminal resize + workspace actions ([#49](https://github.com/utensils/Claudette/issues/49)) ([716b986](https://github.com/utensils/Claudette/commit/716b986f4783d940a08bc821459de786dfd94a60))
* agent chat interface with streaming and persistence ([#15](https://github.com/utensils/Claudette/issues/15)) ([ee373cb](https://github.com/utensils/Claudette/commit/ee373cb32f30861b72637388c587acc2e1f803ec))
* allow browing filesystem when adding repos ([#42](https://github.com/utensils/Claudette/issues/42)) ([a2d7156](https://github.com/utensils/Claudette/commit/a2d71567c04add2543ecc858cca95f3e64233b0b))
* allow resizing vertical and horizontal panes ([95bbbe6](https://github.com/utensils/Claudette/commit/95bbbe6f7be94a39930ad63c839a8222f7755dd9))
* auto start tab when opening terminal pane ([#39](https://github.com/utensils/Claudette/issues/39)) ([572d56e](https://github.com/utensils/Claudette/commit/572d56e084ecd87c31652e829c7595ce312cd754))
* braille spinner and elapsed timer in agent chat ([#61](https://github.com/utensils/Claudette/issues/61)) ([58c42c1](https://github.com/utensils/Claudette/commit/58c42c1b7cf958054ac1bfe2bf225545230ed722))
* configurable terminal font size ([#62](https://github.com/utensils/Claudette/issues/62)) ([e16cee9](https://github.com/utensils/Claudette/commit/e16cee99ba18818e6422cfbc964e4a9826e4a29e))
* diff viewer UI with file tree and side-by-side views ([#18](https://github.com/utensils/Claudette/issues/18)) ([d9bcdbe](https://github.com/utensils/Claudette/commit/d9bcdbeb8026aa08d6ce68040f04bbae7fc4cf40))
* render Lucide icons for repos in sidebar ([#64](https://github.com/utensils/Claudette/issues/64)) ([9b6f1c9](https://github.com/utensils/Claudette/commit/9b6f1c9d1049ad042b27b1910e108ca2f0359d8a))
* scaffold Rust + Iced boilerplate project ([#1](https://github.com/utensils/Claudette/issues/1)) ([43377f6](https://github.com/utensils/Claudette/commit/43377f60ac6be5239bcfa675215e527c433115b3))
* setup scripts for workspace creation ([#50](https://github.com/utensils/Claudette/issues/50)) ([#53](https://github.com/utensils/Claudette/issues/53)) ([ff0d854](https://github.com/utensils/Claudette/commit/ff0d85461df05c14b82521d139f3c8d8fe996be4))
* show repo/branch info in chat header ([#59](https://github.com/utensils/Claudette/issues/59)) ([dbdc70a](https://github.com/utensils/Claudette/commit/dbdc70a030503aaa8dfbb7eaea917c54a376c4ac))
* subscribe to brnach name changes, update sidebar ([#32](https://github.com/utensils/Claudette/issues/32)) ([fb4f37a](https://github.com/utensils/Claudette/commit/fb4f37a7a82384fde0bbaf24a195b0b77513d896))
* tool call summaries and rollup ([#51](https://github.com/utensils/Claudette/issues/51)) ([511c17a](https://github.com/utensils/Claudette/commit/511c17a4ca67a95d90065b6fca036cd04a6968df))
* workspace dashboard with last message preview ([#63](https://github.com/utensils/Claudette/issues/63)) ([fb5126f](https://github.com/utensils/Claudette/commit/fb5126faf9fd9e764d3208767a952784ebf587df))
* workspace management with SQLite and git worktree integration ([#9](https://github.com/utensils/Claudette/issues/9)) ([83f8be7](https://github.com/utensils/Claudette/commit/83f8be7f6563a3d6005d6def88f6ea9d3ec5c796))


### Bug Fixes

* add fix for termianl start back ([#33](https://github.com/utensils/Claudette/issues/33)) ([ef24b5f](https://github.com/utensils/Claudette/commit/ef24b5f4de51df0489b537c6328d3ae33c6b3bd5))
* add macOS SDK library path for libiconv linking ([#10](https://github.com/utensils/Claudette/issues/10)) ([2749466](https://github.com/utensils/Claudette/commit/27494668a381b5e95ab14f65e45bdc4eb6f940bb))
* focus between chat prompt and terminal ([#28](https://github.com/utensils/Claudette/issues/28)) ([7532ae0](https://github.com/utensils/Claudette/commit/7532ae073a19af54e5437e64e7f7b1043b5d4495))
* make permissions select dark style ([#43](https://github.com/utensils/Claudette/issues/43)) ([a46f841](https://github.com/utensils/Claudette/commit/a46f8415351f1a544acf171a5bf4128d5baec59f))
* rewrite agent pane with per-turn process spawning ([#27](https://github.com/utensils/Claudette/issues/27)) ([6cf729a](https://github.com/utensils/Claudette/commit/6cf729a17f6a16547af8939877430f35edcfa84c))
* show checked out branch on load ([#41](https://github.com/utensils/Claudette/issues/41)) ([565ddc1](https://github.com/utensils/Claudette/commit/565ddc1fa23191a956cf750ca48135eddc172cca))
* solve Invalid API Key warning in chat pane ([#34](https://github.com/utensils/Claudette/issues/34)) ([9a696d6](https://github.com/utensils/Claudette/commit/9a696d6bcc75e2f5e330ea5d37d961a7f5c0a067))
* update readme with tauri changes ([#44](https://github.com/utensils/Claudette/issues/44)) ([9c3824c](https://github.com/utensils/Claudette/commit/9c3824cbe7a2d9c58f954c0ce7db92cdaab5b78c))
