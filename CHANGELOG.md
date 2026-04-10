# Changelog

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
