# Changelog

## [0.25.0](https://github.com/utensils/claudette/compare/v0.24.0...v0.25.0) (2026-05-17)


### Features

* add native codex harness foundation ([#786](https://github.com/utensils/claudette/issues/786)) ([35dc249](https://github.com/utensils/claudette/commit/35dc249d68e77d1d4b776e9de2044508590703bf))
* add workspace task history ([#773](https://github.com/utensils/claudette/issues/773)) ([e17739e](https://github.com/utensils/claudette/commit/e17739e0a57d5799d71146a20d23428c2801f92d))
* **agent:** redirect Claude team agents to session tabs ([#787](https://github.com/utensils/claudette/issues/787)) ([fef3c59](https://github.com/utensils/claudette/commit/fef3c5926e9a96b62032dbd3381e9fd22aa323b3))
* auto-detect local agent providers ([#810](https://github.com/utensils/claudette/issues/810)) ([34ce71e](https://github.com/utensils/claudette/commit/34ce71e25bbc3baa83c9f9766b02aa9210e54177))
* **chat:** collapse setup-script output in the transcript ([#784](https://github.com/utensils/claudette/issues/784)) ([6c66ef0](https://github.com/utensils/claudette/commit/6c66ef035209b73f1b71878b36c62b804b10109a))
* **chat:** linkify file paths inside inline code spans ([#803](https://github.com/utensils/claudette/issues/803)) ([a3b561d](https://github.com/utensils/claudette/commit/a3b561de662523988dffae5b2c8d4887f30ebc64))
* **chat:** render sub-agent transcript details ([#796](https://github.com/utensils/claudette/issues/796)) ([553b4d1](https://github.com/utensils/claudette/commit/553b4d1943e909c4a324a472bceed35d17a9f3dc))
* **chat:** summarize CLI invocation banner with model and session id ([#811](https://github.com/utensils/claudette/issues/811)) ([a2fb9f2](https://github.com/utensils/claudette/commit/a2fb9f209a294f3c6daf3e568fce1faf921ae284))
* **chat:** surface skill activations as their own transcript entry ([#777](https://github.com/utensils/claudette/issues/777)) ([ae1629f](https://github.com/utensils/claudette/commit/ae1629faa9de63f3d1454bae5635adbd08921978))
* edit queued chat messages ([f9a1c22](https://github.com/utensils/claudette/commit/f9a1c2288618bb33cc9bc73013368de9a07c8326))
* **file-viewer:** add File/Edit/View/Go menubar and swap Cmd+P bindings to match VS Code ([#830](https://github.com/utensils/claudette/issues/830)) ([2153fea](https://github.com/utensils/claudette/commit/2153feaa558c9e29fccf90741657f352a854622a))
* **mobile:** iOS foundation — pair, browse, chat, approve over WSS ([#840](https://github.com/utensils/claudette/issues/840)) ([ff5f0f5](https://github.com/utensils/claudette/commit/ff5f0f57d87498173e8b163d27e05d9751f806c1))
* **packaging:** publish to the AUR + harden Linux file-dialog UX + add Arch test container ([#828](https://github.com/utensils/claudette/issues/828)) ([d5ee321](https://github.com/utensils/claudette/commit/d5ee3215455245b6e9fb9ff0c1932a72b4f990d0))
* **pi:** add Pi SDK harness as a first-class agent backend (+ optional pi-sdk feature gate) ([#822](https://github.com/utensils/claudette/issues/822)) ([16e66b0](https://github.com/utensils/claudette/commit/16e66b0fca5f620645548c4223ec69e009253f1d))
* **pinned-prompts:** per-prompt toolbar toggle overrides ([#765](https://github.com/utensils/claudette/issues/765)) ([0386a65](https://github.com/utensils/claudette/commit/0386a65dd4a4ae24fba04ebaec2abb69ea515420))
* promote agent backends to first-class settings ([#808](https://github.com/utensils/claudette/issues/808)) ([38fa24b](https://github.com/utensils/claudette/commit/38fa24b6a00b290a691de4e04305ff35c1718ad5))
* **settings:** layered Escape — dismiss inner controls, then exit Settings ([#806](https://github.com/utensils/claudette/issues/806)) ([57d8008](https://github.com/utensils/claudette/commit/57d8008842115603038e998f825b666fe70d8f66))
* **terminal:** add independent terminal zoom ([#794](https://github.com/utensils/claudette/issues/794)) ([d0ddf20](https://github.com/utensils/claudette/commit/d0ddf20d6fafbbb18795e8d39fb3a8a4fea750fe))
* **terminal:** promote Claudette Terminal + route env-provider output, allow mid-resolve toggle ([#820](https://github.com/utensils/claudette/issues/820)) ([a83bc66](https://github.com/utensils/claudette/commit/a83bc667e0ef48c69ce10df20b5a7271fe3dcd42))
* **usage:** composer usage indicator + ToS warning on enable ([#815](https://github.com/utensils/claudette/issues/815)) ([6da30c5](https://github.com/utensils/claudette/commit/6da30c5e82611d48240a8c575ad43c82e6bc505f))
* **workspace:** curate the "Open in app" menu ([#783](https://github.com/utensils/claudette/issues/783)) ([bd16fc0](https://github.com/utensils/claudette/commit/bd16fc0020c9e7f4deb58026e85b27a419a1d120))


### Bug Fixes

* **chat:** highlight selected question options ([#793](https://github.com/utensils/claudette/issues/793)) ([59dbfba](https://github.com/utensils/claudette/commit/59dbfba8376356c26889e4caafa81769a787094d))
* **chat:** keep sticky scroll pinned during live tools ([#831](https://github.com/utensils/claudette/issues/831)) ([94ecfce](https://github.com/utensils/claudette/commit/94ecfce5a23082a492e349832af535589f993f6c))
* **chat:** preserve context across model swaps, cross-harness migration, rollback ([#834](https://github.com/utensils/claudette/issues/834)) ([611abf5](https://github.com/utensils/claudette/commit/611abf542aa4e7e62de9e064ca0e0552b871fad0))
* **chat:** resize oversized image attachments ([#766](https://github.com/utensils/claudette/issues/766)) ([aa78e87](https://github.com/utensils/claudette/commit/aa78e87cfe67cc479877570d1fa588ff3a05c26f))
* **chat:** suppress project context in Haiku rename calls + log silent failures ([#763](https://github.com/utensils/claudette/issues/763)) ([660ddd7](https://github.com/utensils/claudette/commit/660ddd7f52a6cb37de8fecaf7551eddbabfcfa8d))
* **command-palette:** keep arrow navigation locked to the visible row ([#839](https://github.com/utensils/claudette/issues/839)) ([bdc7cae](https://github.com/utensils/claudette/commit/bdc7cae647da7aae951cd35e565d7f4fc9b18f2c))
* Copy Image now works via native OS clipboard backend ([#677](https://github.com/utensils/claudette/issues/677)) ([e9c6592](https://github.com/utensils/claudette/commit/e9c65928d1af33e5c37db9d88ca0fe0a8396d367))
* **dashboard:** make stats strip and analytics grid degrade gracefully at narrow widths ([#805](https://github.com/utensils/claudette/issues/805)) ([1f4c803](https://github.com/utensils/claudette/commit/1f4c8030ac092abd96561233d4d7e84467926660))
* detect JetBrains Toolbox IDEs ([#781](https://github.com/utensils/claudette/issues/781)) ([8a6b2b2](https://github.com/utensils/claudette/commit/8a6b2b2dcdd2033b76931862f9cee678ce8f9766))
* **devshell:** forward args ("$@") in build-app / fmt / run-tests wrappers ([#802](https://github.com/utensils/claudette/issues/802)) ([6ac6408](https://github.com/utensils/claudette/commit/6ac6408df8e146b90cc45a03d18aec66fa8442e3))
* **env-provider:** hydrate repo settings in server ([#809](https://github.com/utensils/claudette/issues/809)) ([f4aa18b](https://github.com/utensils/claudette/commit/f4aa18b5922491620a925323bea2b8c27167ea92))
* **env:** emit workspace_env_trust_needed from create/fork warmup ([#821](https://github.com/utensils/claudette/issues/821)) ([3f676b8](https://github.com/utensils/claudette/commit/3f676b8cb5c56db1fa19beca5d6675cabab2a5d8))
* **fork:** hydrate forked workspace with remote_connection_id stamp ([#816](https://github.com/utensils/claudette/issues/816)) ([9dba0fd](https://github.com/utensils/claudette/commit/9dba0fdff391893afd628190c898931c6dae2e22))
* **help:** route nightly builds to the rolling GitHub release tag ([#814](https://github.com/utensils/claudette/issues/814)) ([1329fbf](https://github.com/utensils/claudette/commit/1329fbfae38f4881b651a0e7624147e4ccc9f3fb))
* **models:** remove stale \"Experimental Codex\" label from DB-persisted backend configs ([#817](https://github.com/utensils/claudette/issues/817)) ([f243f65](https://github.com/utensils/claudette/commit/f243f651a22bafaa443dbb589aa10cbefc69b5db))
* open chat file links in Monaco ([#798](https://github.com/utensils/claudette/issues/798)) ([9a21e1f](https://github.com/utensils/claudette/commit/9a21e1ffe91731c865448b6b2bbd66942edad7a5))
* preserve initial terminal output ([#774](https://github.com/utensils/claudette/issues/774)) ([2c09efe](https://github.com/utensils/claudette/commit/2c09efe78450a485311437a51cce703fda4acc04))
* preserve queued messages on agent stop ([#771](https://github.com/utensils/claudette/issues/771)) ([81abacc](https://github.com/utensils/claudette/commit/81abacc16c1860c2836021103a1b6c4e2884d803))
* prevent archived workspace overflow ([#775](https://github.com/utensils/claudette/issues/775)) ([97efccc](https://github.com/utensils/claudette/commit/97efccc31da62e64e381d3a14d51207239123991))
* require direnv reapproval after envrc changes ([#776](https://github.com/utensils/claudette/issues/776)) ([3d379fd](https://github.com/utensils/claudette/commit/3d379fd9a60850cbcdda904860670c0384059dbb))
* stabilize chat auth flow when env-providers fail ([#782](https://github.com/utensils/claudette/issues/782)) ([c033552](https://github.com/utensils/claudette/commit/c033552441dd30271045d64c39fb0a0d84d7b9b3))
* stabilize context meter during env startup ([#779](https://github.com/utensils/claudette/issues/779)) ([e02437e](https://github.com/utensils/claudette/commit/e02437e7a1f481e4548dd9683887cbd395df6c68))
* **task-tracker:** align with Claude Code's Task* tool family, archive history across sessions ([#836](https://github.com/utensils/claudette/issues/836)) ([45265f1](https://github.com/utensils/claudette/commit/45265f120b65e9e0ebc74a7273e174fc3ad7ca0c))
* **terminal:** stop panel re-opening on every workspace switch ([#832](https://github.com/utensils/claudette/issues/832)) ([dff084b](https://github.com/utensils/claudette/commit/dff084bed57c7cfce75eadebd76a69f2d5104a4e))
* **workspace:** self-heal a stale sidebar row when env prep reports it's gone ([#785](https://github.com/utensils/claudette/issues/785)) ([69fac8b](https://github.com/utensils/claudette/commit/69fac8bc0eb0933134929f4f3d8466504f0ca5ee))


### Performance Improvements

* **scm:** tier polling by workspace focus and activity to reduce idle churn ([#757](https://github.com/utensils/claudette/issues/757)) ([a146ec5](https://github.com/utensils/claudette/commit/a146ec5d9e2cb9fffa5eb4519c5b884b6953bbb1))

## [0.24.0](https://github.com/utensils/claudette/compare/v0.23.0...v0.24.0) (2026-05-11)


### Features

* add alternative Claude Code backends ([#671](https://github.com/utensils/claudette/issues/671)) ([bf32a06](https://github.com/utensils/claudette/commit/bf32a06e5d2b9b1513536535dba71477fc690eee))
* add archive scripts for workspaces ([#662](https://github.com/utensils/claudette/issues/662)) ([1f097da](https://github.com/utensils/claudette/commit/1f097da26ee2f4392107b414dfe2fbe3679cb9d9))
* add Claude Code auth recovery UI ([#727](https://github.com/utensils/claudette/issues/727)) ([fa4af4f](https://github.com/utensils/claudette/commit/fa4af4fd57b289e61b73b524ceda7c4ac4821f9c))
* add Open Graph image for social link previews ([#674](https://github.com/utensils/claudette/issues/674)) ([7288aee](https://github.com/utensils/claudette/commit/7288aeea8e7eb867f63f9ea93eae52ff9f658542))
* add queue steer popup ([#705](https://github.com/utensils/claudette/issues/705)) ([08e2761](https://github.com/utensils/claudette/commit/08e27611c71eaecc7eb870a96e1fa51c63618b2c))
* add shell command composer mode ([#640](https://github.com/utensils/claudette/issues/640)) ([135aeb9](https://github.com/utensils/claudette/commit/135aeb9190bc289310949ec2551376d6ab015a0b))
* add workspace context menu ([#670](https://github.com/utensils/claudette/issues/670)) ([e8db548](https://github.com/utensils/claudette/commit/e8db54871f37e107eb23022af18284c0cc5b7c3b))
* animate panel toggles ([#660](https://github.com/utensils/claudette/issues/660)) ([c083bbf](https://github.com/utensils/claudette/commit/c083bbfbfdb4319def120036b6259a71f8c4bb11))
* **backends:** add LM Studio backend with reliable upstream error surfacing ([#740](https://github.com/utensils/claudette/issues/740)) ([ee661b8](https://github.com/utensils/claudette/commit/ee661b8530872573a123a605a0ab29f1d32b3fc6))
* **chat:** add configurable tool call display ([#696](https://github.com/utensils/claudette/issues/696)) ([42b1bbf](https://github.com/utensils/claudette/commit/42b1bbf3128380e0db90ec4ed4e5b71f5e320486))
* **chat:** collapse live tool calls and agents by default in grouped mode ([#743](https://github.com/utensils/claudette/issues/743)) ([8079251](https://github.com/utensils/claudette/commit/80792512c6830513256a2db533b51d045d53fc10))
* **chat:** collapsible file-change summary with syntax highlighting ([#721](https://github.com/utensils/claudette/issues/721)) ([ee01541](https://github.com/utensils/claudette/commit/ee015417c7d8a1d0f9de84ab425995850532cb6b))
* **chat:** per-turn edit summary card with inline diffs and Monaco open ([#710](https://github.com/utensils/claudette/issues/710)) ([a9c8239](https://github.com/utensils/claudette/commit/a9c8239ed2d5ace299bb9cddeba590644b3d6900))
* **chat:** redesign CLI invocation banner as collapsible structured chip ([#689](https://github.com/utensils/claudette/issues/689)) ([39d810e](https://github.com/utensils/claudette/commit/39d810ec71a42c2256c7fc51611dc90df79c6ee0))
* **chat:** show pulsing pending indicator when steering prompt is in-flight ([#744](https://github.com/utensils/claudette/issues/744)) ([4995f8a](https://github.com/utensils/claudette/commit/4995f8aede961703f12562dd592109bb9fb9bdbf))
* Claude CLI flags — settings panel, in-chat surfaces, and invocation banner ([#673](https://github.com/utensils/claudette/issues/673)) ([429c630](https://github.com/utensils/claudette/commit/429c630f6aa9b5e47392ebb0a8f3bfe6d6bbe66c))
* Claude Code Remote Control ([#686](https://github.com/utensils/claudette/issues/686)) ([9153d99](https://github.com/utensils/claudette/commit/9153d99d870a99ce5b0d460b358fb961d1860aa5))
* **cli:** claudette command-line client + shared ops core ([#620](https://github.com/utensils/claudette/issues/620)) ([712e73e](https://github.com/utensils/claudette/commit/712e73ecaf6d147bcabfd81ee1ccc03b92313ed9))
* **editor:** add user-toggleable Monaco minimap ([#637](https://github.com/utensils/claudette/issues/637)) ([c36f552](https://github.com/utensils/claudette/commit/c36f552d691d4efb3b824d8fd1d9cfe54fe5ab08))
* **env-providers:** one-time per-project trust modal + Sidebar/Dashboard icon parity ([#758](https://github.com/utensils/claudette/issues/758)) ([0b2ceea](https://github.com/utensils/claudette/commit/0b2ceeae96cca80742561a08fe0d2cde543f131c))
* **env:** configurable env-provider timeouts + per-repo trust prompt + UX/perf fixes ([#750](https://github.com/utensils/claudette/issues/750)) ([29f8613](https://github.com/utensils/claudette/commit/29f86138818c80be059acee05591842d604f5122))
* expose chat orchestration over ipc ([#650](https://github.com/utensils/claudette/issues/650)) ([fed931f](https://github.com/utensils/claudette/commit/fed931f07ce48da7013b707090524d16ac095232))
* file context menu, inline rename, undoable trash ([#655](https://github.com/utensils/claudette/issues/655)) ([ed6ab2c](https://github.com/utensils/claudette/commit/ed6ab2c8cbf3d8f984c7a898ad0a8db5032afcc5))
* improve native app feel ([#717](https://github.com/utensils/claudette/issues/717)) ([9e18c0d](https://github.com/utensils/claudette/commit/9e18c0d872b39928537b08e4cd293d54b5deebb0))
* improve workspace opener app selection ([#704](https://github.com/utensils/claudette/issues/704)) ([e6a9930](https://github.com/utensils/claudette/commit/e6a99306bcf2d2b53630aca22520a5f56e2a2030))
* inline tool activity when grouping is disabled ([#708](https://github.com/utensils/claudette/issues/708)) ([47bba80](https://github.com/utensils/claudette/commit/47bba80c96b7995acca72e728d83afac1a109eb9))
* **modals:** create new project from within Claudette ([#719](https://github.com/utensils/claudette/issues/719)) ([eaebed8](https://github.com/utensils/claudette/commit/eaebed87805f050c990aa00d91df2212c5026760))
* poll files and changes tabs while agent is idle ([#676](https://github.com/utensils/claudette/issues/676)) ([e31c10d](https://github.com/utensils/claudette/commit/e31c10d4e5802fc0f81d3d695c3efcbee7063326))
* redesign Claude CLI flags settings with sections + browse list ([#691](https://github.com/utensils/claudette/issues/691)) ([63ffdd1](https://github.com/utensils/claudette/commit/63ffdd15fbd2148198e4e26bc73be4ef99a9acc2))
* render filetree icons via material-icon-theme ([#681](https://github.com/utensils/claudette/issues/681)) ([5d9fb4f](https://github.com/utensils/claudette/commit/5d9fb4fdcdf3afd47f15c27e92fc0c0aad7b873e))
* show custom hotkeys in tooltips ([#712](https://github.com/utensils/claudette/issues/712)) ([eb405cd](https://github.com/utensils/claudette/commit/eb405cdc591c1852a5845089641be695aca39832))
* show detailed SCM checks ([#657](https://github.com/utensils/claudette/issues/657)) ([4493035](https://github.com/utensils/claudette/commit/449303517c1312bc2f7e228f2c409b5772b84e8c))
* show git status in file tree ([#648](https://github.com/utensils/claudette/issues/648)) ([f237a4f](https://github.com/utensils/claudette/commit/f237a4f49589ace7f3b8bfbdf8a701d43addc84f))
* **sidebar:** stop running terminal commands from sidebar indicator ([#697](https://github.com/utensils/claudette/issues/697)) ([2c58323](https://github.com/utensils/claudette/commit/2c583234aa390fa4e0a8606bfd22fbc292d407dc))
* tint files browser rows by change status ([#678](https://github.com/utensils/claudette/issues/678)) ([be0471c](https://github.com/utensils/claudette/commit/be0471ce04dfd3727af36c0f290f7cb8dd13f2d1))
* **ui:** drag-reorder for tabs/workspaces + unified tab order, view persistence, alignment ([#631](https://github.com/utensils/claudette/issues/631)) ([6c5e7ed](https://github.com/utensils/claudette/commit/6c5e7ed70551d9b2292882a5a1e50c77ed0c2f9e))
* **ui:** help menu — keyboard shortcuts, docs, changelog, dev tools ([#643](https://github.com/utensils/claudette/issues/643)) ([367ac24](https://github.com/utensils/claudette/commit/367ac24ce6e08444b72d48b4dd3679521d947342))
* **updater:** boot-health gate — pre-publish smoke + post-install heartbeat-or-rollback ([#735](https://github.com/utensils/claudette/issues/735)) ([fcd7364](https://github.com/utensils/claudette/commit/fcd7364a55d2fbc86a4d7f482e11299b69aae950))
* use default terminal app for workspace opener ([#711](https://github.com/utensils/claudette/issues/711)) ([5b2028b](https://github.com/utensils/claudette/commit/5b2028bdd25e72773493b7c43387bb470f2cf4eb))
* **welcome:** welcome screen + project-scoped view + empty-tabs view ([#723](https://github.com/utensils/claudette/issues/723)) ([9dbd196](https://github.com/utensils/claudette/commit/9dbd1960547042ac8edf70a43a390b3eca47696b))
* **windows:** native SAPI 5.4 voice-to-text via in-process COM ([#737](https://github.com/utensils/claudette/issues/737)) ([3189355](https://github.com/utensils/claudette/commit/31893553e03869fbdc1d242ffc07ef3c016fbb44))


### Bug Fixes

* **apps:** unbreak Linux nightly — icon helpers also consume on Linux ([#739](https://github.com/utensils/claudette/issues/739)) ([59dfd95](https://github.com/utensils/claudette/commit/59dfd958272d0836e9d49514400b0c84276cee82))
* **backends:** tolerate unknown backend variants in stored settings ([#742](https://github.com/utensils/claudette/issues/742)) ([204c074](https://github.com/utensils/claudette/commit/204c0745b19dba77c3d310eba0ff4a3c39abd814))
* **chat:** don't misreport missing worktree as missing CLI ([#747](https://github.com/utensils/claudette/issues/747)) ([124a979](https://github.com/utensils/claudette/commit/124a9797a37cf94ea0adb833095ecaa657a13bb8))
* **chat:** drop Opus 1M extra-usage indicator (included on Max/Team/Enterprise) ([#745](https://github.com/utensils/claudette/issues/745)) ([98f8bcd](https://github.com/utensils/claudette/commit/98f8bcde689456627690c5dcdc4c81e2d00957ad))
* **chat:** keep live agent tool groups stable ([#639](https://github.com/utensils/claudette/issues/639)) ([ae080f8](https://github.com/utensils/claudette/commit/ae080f81db5a47448871cb9249d798ef18ce0feb))
* **chat:** suppress empty-tabs flash during workspace switch and app launch ([#759](https://github.com/utensils/claudette/issues/759)) ([3fd4194](https://github.com/utensils/claudette/commit/3fd4194df452d5a1046b977bca50158c03310043))
* **chat:** toggle context meter popover correctly on re-click ([#702](https://github.com/utensils/claudette/issues/702)) ([5ae00e4](https://github.com/utensils/claudette/commit/5ae00e4538f36a82c14f45b50375214b759d105e))
* **ci:** keep Cargo release versions in sync ([#666](https://github.com/utensils/claudette/issues/666)) ([e76cfc9](https://github.com/utensils/claudette/commit/e76cfc9956eee10948392c6095a7d0d9142a1a0f))
* correct soundpack detail link domain to openpeon.com ([#675](https://github.com/utensils/claudette/issues/675)) ([83d9ac2](https://github.com/utensils/claudette/commit/83d9ac2d74d99045761f3971ba6694af4990a73f))
* **dashboard:** anchor elapsed timer to store promptStartTime ([#632](https://github.com/utensils/claudette/issues/632)) ([cdf7aa9](https://github.com/utensils/claudette/commit/cdf7aa9a32519cb0f5ea5d3c4dd91c4c8ecb9839)), closes [#589](https://github.com/utensils/claudette/issues/589)
* **dashboard:** kill elastic overscroll, reuse ChatPanel's bounce-prevention ([#760](https://github.com/utensils/claudette/issues/760)) ([561ffea](https://github.com/utensils/claudette/commit/561ffeac74235c6633784c87402d74bdae1a56f0))
* defer macOS microphone permission prompt ([#668](https://github.com/utensils/claudette/issues/668)) ([dd9ef3b](https://github.com/utensils/claudette/commit/dd9ef3b9cec3d535a58bf289406f119ef1707f01))
* **dev:** --clean also sandboxes ~/.claude/ via CLAUDE_CONFIG_DIR ([#733](https://github.com/utensils/claudette/issues/733)) ([a0b5fe9](https://github.com/utensils/claudette/commit/a0b5fe9a1cc187fe1129d3aa0c9f143587046b3c))
* **diff:** copy button silently failing on &gt;100KB files; unify clipboard logic ([#636](https://github.com/utensils/claudette/issues/636)) ([fee963b](https://github.com/utensils/claudette/commit/fee963b689d34e79575c49848929208453ac9aa9))
* **diff:** prevent git-poll pileup on divergent forks ([#706](https://github.com/utensils/claudette/issues/706)) ([d093a0f](https://github.com/utensils/claudette/commit/d093a0f49165d442d84d71a48b0d1d2f69db80db))
* **env-direnv:** drop direnv allow/deny stamps from watched list ([#756](https://github.com/utensils/claudette/issues/756)) ([3ea8c5c](https://github.com/utensils/claudette/commit/3ea8c5cddbf7ef6fe6c5e253919686b617e94eee))
* **env-direnv:** strip direnv's internal markers so they don't break the in-shell hook ([#751](https://github.com/utensils/claudette/issues/751)) ([596c38b](https://github.com/utensils/claudette/commit/596c38be01f8a9f04c5ab0f8aad8f31c83b28ded))
* **env-provider:** treat missing CLI as unavailable, not error ([#720](https://github.com/utensils/claudette/issues/720)) ([6af6cad](https://github.com/utensils/claudette/commit/6af6cad2b823436c63ff1e78f81e03db07e021f6))
* **file-viewer,zoom:** correct context-menu offset under html zoom ([#656](https://github.com/utensils/claudette/issues/656)) ([49b005a](https://github.com/utensils/claudette/commit/49b005a6231f74c55be0960e3c0e57b2165d2a34))
* **files:** show all files including gitignored in Files panel ([#694](https://github.com/utensils/claudette/issues/694)) ([0c40360](https://github.com/utensils/claudette/commit/0c40360b7d612fb1062cbc6414df32989283176e))
* **fork:** restore conversation context across forks ([#690](https://github.com/utensils/claudette/issues/690)) ([9852d86](https://github.com/utensils/claudette/commit/9852d8674b036e50dabecd5c699db42a02e0a094))
* hide deprecated flags from Claude flags settings ([#688](https://github.com/utensils/claudette/issues/688)) ([f02d12e](https://github.com/utensils/claudette/commit/f02d12e816ff0ac5b2b7a1fe8475d7521cdbebf5))
* improve tool call summary and detail rendering ([#714](https://github.com/utensils/claudette/issues/714)) ([2d4bef4](https://github.com/utensils/claudette/commit/2d4bef45effe1a143e0862589f3c8f4ac85b728d))
* isolate plugin settings load failures ([#728](https://github.com/utensils/claudette/issues/728)) ([e675a3d](https://github.com/utensils/claudette/commit/e675a3d9d1f61f176d141b2d8772c187720603d3))
* keep close-tab focus on left neighbor ([#707](https://github.com/utensils/claudette/issues/707)) ([dde083a](https://github.com/utensils/claudette/commit/dde083a8c170430cc48f9010c1c551ec23bb9053))
* keep turn edit summaries session-scoped ([#713](https://github.com/utensils/claudette/issues/713)) ([374650b](https://github.com/utensils/claudette/commit/374650b3b7c5441b974e81f77220062f653f31b2))
* load env providers before workspace use ([#715](https://github.com/utensils/claudette/issues/715)) ([270da03](https://github.com/utensils/claudette/commit/270da03ac283348752f99f22e953ff99db599623))
* **macos:** replace mac-notification-sys with UNUserNotificationCenter ([#736](https://github.com/utensils/claudette/issues/736)) ([#738](https://github.com/utensils/claudette/issues/738)) ([b56a13e](https://github.com/utensils/claudette/commit/b56a13eb68dd209a815f71bf3219bf37b84925b7))
* make CSV attachment headers opaque ([#647](https://github.com/utensils/claudette/issues/647)) ([8a91074](https://github.com/utensils/claudette/commit/8a9107497b65171f6a4285f607ee4b24ce634201))
* **missing_cli:** update Claude Code install options to match official docs ([#699](https://github.com/utensils/claudette/issues/699)) ([62fc66c](https://github.com/utensils/claudette/commit/62fc66c664e4098f9692af3f6162042287f78b67))
* persist window and workspace view state ([#672](https://github.com/utensils/claudette/issues/672)) ([49ac6ab](https://github.com/utensils/claudette/commit/49ac6abc220114c172a83443847dbdbbe7b29313))
* **plugins:** show install CTA when claude CLI is missing ([#642](https://github.com/utensils/claudette/issues/642)) ([a260930](https://github.com/utensils/claudette/commit/a260930567c12ecc3b2c29d8c3299c3c40757f12))
* **plugins:** use unified claude CLI resolver in marketplace commands ([#654](https://github.com/utensils/claudette/issues/654)) ([4e56a03](https://github.com/utensils/claudette/commit/4e56a0391f2dcd4aed51298c35238b3b88d3837c))
* preserve CLI workspace names ([#682](https://github.com/utensils/claudette/issues/682)) ([fa1e57f](https://github.com/utensils/claudette/commit/fa1e57fe12df863edf45b28930101c0eff7a5259))
* preserve terminals across workspace navigation ([#734](https://github.com/utensils/claudette/issues/734)) ([e4231fb](https://github.com/utensils/claudette/commit/e4231fb783139a066d27ead75481152e517f8c19))
* prevent smart quote substitutions in repo settings ([#667](https://github.com/utensils/claudette/issues/667)) ([6fcaa54](https://github.com/utensils/claudette/commit/6fcaa5438a4dfc965d4bfd97784a0456ff48165c))
* prevent thinking hotkey overlap ([#683](https://github.com/utensils/claudette/issues/683)) ([d16cef5](https://github.com/utensils/claudette/commit/d16cef53f14ced97cf055a964f4261131c57b0ee))
* remove 'PR' label text from PR pill button in header ([#665](https://github.com/utensils/claudette/issues/665)) ([3be20e5](https://github.com/utensils/claudette/commit/3be20e5fc6b9e11547408da0073c3e32b04908a4))
* render SVGs in markdown preview ([#659](https://github.com/utensils/claudette/issues/659)) ([a1a565e](https://github.com/utensils/claudette/commit/a1a565e4ba92aea2787d364719a19e0124fd163e))
* repair attachment file copy ([#646](https://github.com/utensils/claudette/issues/646)) ([f0ec014](https://github.com/utensils/claudette/commit/f0ec0148ed856369fbfa30968692c053e36fb98e))
* restore workspace auto sorting ([#658](https://github.com/utensils/claudette/issues/658)) ([3eb31e1](https://github.com/utensils/claudette/commit/3eb31e1082fd3d0594d26f1011e44097a892d4bd))
* **scm:** instant PR status on workspace switch, log GitHub API errors ([#746](https://github.com/utensils/claudette/issues/746)) ([8d0e319](https://github.com/utensils/claudette/commit/8d0e3195c9a5ecbd5df3f4589aa9fd6adf2083bb))
* **scm:** preserve cached PR status across transient poll failures ([#663](https://github.com/utensils/claudette/issues/663)) ([07339f0](https://github.com/utensils/claudette/commit/07339f0936325c5977eab9f0832d38857ff54100))
* stage cli sidecar for dev builds ([#645](https://github.com/utensils/claudette/issues/645)) ([069e8d4](https://github.com/utensils/claudette/commit/069e8d48a53136a6db342e8092e933e02022bcf1))
* stop stale macOS dev app instances ([#653](https://github.com/utensils/claudette/issues/653)) ([2ac9cdf](https://github.com/utensils/claudette/commit/2ac9cdf6900317ac5370ffb0172c2966ed0bb29a))
* sync sidebar status badge with session attention state ([#661](https://github.com/utensils/claudette/issues/661)) ([2f94492](https://github.com/utensils/claudette/commit/2f944923ac6ae121f5b91692e1dbd6881c225ae4))
* **terminal:** activate left neighbor tab instead of first tab on close ([#753](https://github.com/utensils/claudette/issues/753)) ([58f4c57](https://github.com/utensils/claudette/commit/58f4c57b1545cf3d7535b0c0f49d7525c9ce51a1))
* **terminal:** add copy/paste keyboard shortcuts and context menu items ([#692](https://github.com/utensils/claudette/issues/692)) ([f5765f5](https://github.com/utensils/claudette/commit/f5765f549f82a3aba491863789300ac162709455))
* **ui:** inline useCreateWorkspace into main bundle to fix prod blank screen ([#730](https://github.com/utensils/claudette/issues/730)) ([15b1697](https://github.com/utensils/claudette/commit/15b16972343470abdd1dbdfbcb9981d8a12aeb6d))
* **ui:** un-break release boot from Vite-mangled inline hijack guard ([#634](https://github.com/utensils/claudette/issues/634)) ([95c70b8](https://github.com/utensils/claudette/commit/95c70b8fcf23180ff0b7e79b663d492482f7b250))
* use body-size token for sidebar font sizes ([#679](https://github.com/utensils/claudette/issues/679)) ([5d59c9a](https://github.com/utensils/claudette/commit/5d59c9a5b2959609be6f69d76e754da2acd37ef3))
* **windows:** editor gutter CRLF, settings drag-region click offset, NSIS install defaults ([#741](https://github.com/utensils/claudette/issues/741)) ([cfdf24b](https://github.com/utensils/claudette/commit/cfdf24b425c8f644a1c7f5d18ae5781045753e16))
* **windows:** integrated terminal PowerShell profile + env-prep UI lock recovery ([#752](https://github.com/utensils/claudette/issues/752)) ([bcd077a](https://github.com/utensils/claudette/commit/bcd077a220a38e76a1dee84784b7bbfdc9eae755))
* **windows:** notification sounds and OpenPeon sound packs play correctly ([#732](https://github.com/utensils/claudette/issues/732)) ([3c9fbcb](https://github.com/utensils/claudette/commit/3c9fbcb38522aad2ade7c5b64ee3a5f2d5840897))
* **windows:** suppress cmd.exe window flash on session-name generation ([#761](https://github.com/utensils/claudette/issues/761)) ([a470bdc](https://github.com/utensils/claudette/commit/a470bdc0948dedd2b553f7a90bc45968867fa770))
* **windows:** three follow-up gaps surfaced after the bring-up sweep ([#749](https://github.com/utensils/claudette/issues/749)) ([5b0143a](https://github.com/utensils/claudette/commit/5b0143a8b6f7e4fda27f64bbe377d97f84580843))
* **workspace:** setup script runs before env-provider; neutral terminal env overlay copy ([#754](https://github.com/utensils/claudette/issues/754)) ([68df742](https://github.com/utensils/claudette/commit/68df7428be183fb277d9dd7cadd86734064717a8))

## [0.23.0](https://github.com/utensils/claudette/compare/v0.22.0...v0.23.0) (2026-05-05)


### Features

* add configurable hotkeys ([#621](https://github.com/utensils/claudette/issues/621)) ([7c754fb](https://github.com/utensils/claudette/commit/7c754fb6689f10a9f2a051942e6884ed90a828e3))
* add mid-turn steering for queued messages ([#629](https://github.com/utensils/claudette/issues/629)) ([b8db6a5](https://github.com/utensils/claudette/commit/b8db6a53d1dad2be40ec6110635e4ede699047b4))
* **chat:** add copy-to-clipboard button to plan approval card ([#630](https://github.com/utensils/claudette/issues/630)) ([fe63d56](https://github.com/utensils/claudette/commit/fe63d56b01b2fa66766011478d8f4657aae2885a))
* **icon-picker:** expand curated icon set for workspace differentiation ([#600](https://github.com/utensils/claudette/issues/600)) ([f164550](https://github.com/utensils/claudette/commit/f1645505b5234ccd750121d8071eda2360bf3a76))
* **settings:** configurable git gutter base in new Editor section ([#602](https://github.com/utensils/claudette/issues/602)) ([1dd242e](https://github.com/utensils/claudette/commit/1dd242e2f48eb2d5a7334dfde4dafa02a9224a5d))
* **site:** use Silkscreen pixel font for header brand title ([#606](https://github.com/utensils/claudette/issues/606)) ([ac243f0](https://github.com/utensils/claudette/commit/ac243f037e4b6442518f2c20401678d45f795956))
* **terminal:** agent background terminal tabs + drag/context-menu polish ([#625](https://github.com/utensils/claudette/issues/625)) ([5e7b201](https://github.com/utensils/claudette/commit/5e7b201bcb964d9df7425d39a27d25e6dde66df2))
* **voice:** cancel in-flight transcription end-to-end ([#615](https://github.com/utensils/claudette/issues/615)) ([e14dba2](https://github.com/utensils/claudette/commit/e14dba2413f41ef7a20beb5e6e90270b166f1170))
* **voice:** keyboard shortcuts for toggle and hold-to-talk ([#441](https://github.com/utensils/claudette/issues/441).2) ([#617](https://github.com/utensils/claudette/issues/617)) ([cc4bef2](https://github.com/utensils/claudette/commit/cc4bef2dd274ea98de1279c247e1416218f80ce2))
* **voice:** real VU meter driven by RMS from cpal ([#441](https://github.com/utensils/claudette/issues/441) item 4) ([#616](https://github.com/utensils/claudette/issues/616)) ([22ac4e4](https://github.com/utensils/claudette/commit/22ac4e45439e5aa82a8e3bf30b8ca01ec7038d5b))


### Bug Fixes

* **hotkeys:** restore push-to-talk on Right Alt and add keyboard-shortcut search ([#627](https://github.com/utensils/claudette/issues/627)) ([3ee2359](https://github.com/utensils/claudette/commit/3ee2359b575b9f2deb1e0a9c52cd4f082abdc497))
* **sidebar:** surface rename failures via toast ([#626](https://github.com/utensils/claudette/issues/626)) ([527434e](https://github.com/utensils/claudette/commit/527434e1d42aeee5a26a49c2fa5f55bb75b7dd91))
* **site:** pin header brand title to Silkscreen weight 400 ([#608](https://github.com/utensils/claudette/issues/608)) ([91fb586](https://github.com/utensils/claudette/commit/91fb58672e52a9a63affa9e01dc77fa3cfd0cc2d))
* **ui:** prevent repo name overlap with macOS traffic lights when sidebar closed ([#605](https://github.com/utensils/claudette/issues/605)) ([af4a165](https://github.com/utensils/claudette/commit/af4a1654c251dc4f2ed3accbe6c5455047fdee62))
* **ui:** pulse dashboard ask/plan/done icons to match sidebar ([#611](https://github.com/utensils/claudette/issues/611)) ([714b5aa](https://github.com/utensils/claudette/commit/714b5aaf89f2a3cfcd470b930440416ac4cc6c50))

## [0.22.0](https://github.com/utensils/claudette/compare/v0.21.0...v0.22.0) (2026-05-04)


### Features

* **agent:** inject bundled global system prompt into every session ([#560](https://github.com/utensils/claudette/issues/560)) ([829ffb6](https://github.com/utensils/claudette/commit/829ffb6a47dacc836675773d1dd7aa3d671d93a5))
* **changes:** committed group, diff stats, and open-in-editor for commit files + diff toolbar ([#598](https://github.com/utensils/claudette/issues/598)) ([d390286](https://github.com/utensils/claudette/commit/d3902862e82958c94a1463b58d9d832b9a60f388))
* **changes:** expandable commit list in Changes panel ([#593](https://github.com/utensils/claudette/issues/593)) ([f55e20f](https://github.com/utensils/claudette/commit/f55e20f9065a395e79611b7b3bd07743b88ef08b))
* **changes:** per-file and bulk stage/unstage/discard controls ([#592](https://github.com/utensils/claudette/issues/592)) ([e59d816](https://github.com/utensils/claudette/commit/e59d81613bc7e50493451ed9554a1057fe454f82))
* **chat:** paginate history and bundle attachments per page ([#489](https://github.com/utensils/claudette/issues/489)) ([#564](https://github.com/utensils/claudette/issues/564)) ([41cf76f](https://github.com/utensils/claudette/commit/41cf76ffd170c80ccaeb36ac275a228ca57790dc))
* **community:** registry MVP — discover, install, uninstall third-party plugins ([#567](https://github.com/utensils/claudette/issues/567) PR 2 + [#570](https://github.com/utensils/claudette/issues/570)) ([#572](https://github.com/utensils/claudette/issues/572)) ([a5fb802](https://github.com/utensils/claudette/commit/a5fb802539e96a8840375dc49367a591dfa0585d))
* **community:** verify minisign-signed registry + commit-pin install URLs ([#586](https://github.com/utensils/claudette/issues/586)) ([a61104e](https://github.com/utensils/claudette/commit/a61104e71483f4f8e6773b5c02405f2f2fe09c00))
* **file-viewer:** show git gutter markers in Monaco editor ([#596](https://github.com/utensils/claudette/issues/596)) ([4821253](https://github.com/utensils/claudette/commit/482125313167208fe35a9db48bea0cd193d5718c))
* **files:** add tabbed Files browser with Monaco editor ([#556](https://github.com/utensils/claudette/issues/556)) ([266203f](https://github.com/utensils/claudette/commit/266203f02bb45bf23d42baff2fade510e1471aa5))
* generalize pinned commands and move management into settings ([#541](https://github.com/utensils/claudette/issues/541)) ([8029ec3](https://github.com/utensils/claudette/commit/8029ec388cda263b28a291c4f2dbd419089d09ca))
* **pinned-prompts:** redesign settings UI and add slash autocomplete ([#544](https://github.com/utensils/claudette/issues/544)) ([e6326fa](https://github.com/utensils/claudette/commit/e6326fa91694abc91633557d74001e48dc1fb51a))
* **plugins:** enforce granted_capabilities at every host.* call site ([#585](https://github.com/utensils/claudette/issues/585)) ([941029c](https://github.com/utensils/claudette/commit/941029ca49576edd5cfbde22f6413eff02349e05))
* **plugins:** language-grammar plugin kind ([#568](https://github.com/utensils/claudette/issues/568)) ([0c2966e](https://github.com/utensils/claudette/commit/0c2966ef954f960af6c230f11f96de7984690798))
* **site:** add Themeable and Remote access feature cards ([#599](https://github.com/utensils/claudette/issues/599)) ([cc5029a](https://github.com/utensils/claudette/commit/cc5029a34e38853189633f61f4217d7fe9ba758b))
* **site:** redesign homepage to v2 with pillars, anatomy, and real-app icons ([#533](https://github.com/utensils/claudette/issues/533)) ([c51b349](https://github.com/utensils/claudette/commit/c51b3498f636891715c1d5d9a618ca28b5a725bf))
* **tabs:** right-click context menus and Actions menu in diff view ([#557](https://github.com/utensils/claudette/issues/557)) ([994602b](https://github.com/utensils/claudette/commit/994602b47c1558e10e8d1363eb32111771a848d6))
* **ui:** files-first right sidebar, terminal/chat polish, drop file viewer view/edit toggle ([#566](https://github.com/utensils/claudette/issues/566)) ([3181e71](https://github.com/utensils/claudette/commit/3181e713a26fc13bdfa7ef92dab809756cba0c08))


### Bug Fixes

* **apps:** drop redundant path arg from nvim/vim launch ([#558](https://github.com/utensils/claudette/issues/558)) ([2e4f5d3](https://github.com/utensils/claudette/commit/2e4f5d381213c20c4302ac3e21a168c0833e12d5))
* **cesp:** drop refs/tags/ prefix from pack archive URL ([#551](https://github.com/utensils/claudette/issues/551)) ([bb35515](https://github.com/utensils/claudette/commit/bb3551515c9a2fc4ef046b0b5bfeed4deb700ce2))
* **chat:** require Shift modifier for input history navigation ([#555](https://github.com/utensils/claudette/issues/555)) ([b033bc2](https://github.com/utensils/claudette/commit/b033bc286a9b8f08361826fb303fcf2eda36de44))
* **chat:** stabilize streaming spinner rotation ([#552](https://github.com/utensils/claudette/issues/552)) ([a9c286d](https://github.com/utensils/claudette/commit/a9c286d24cc43afb21eff376585e5e40a919e718)), closes [#545](https://github.com/utensils/claudette/issues/545)
* **chat:** unblock + new session button while a session is streaming ([#574](https://github.com/utensils/claudette/issues/574)) ([#575](https://github.com/utensils/claudette/issues/575)) ([d4a083c](https://github.com/utensils/claudette/commit/d4a083c0df0a45c47d2eae69769e2837eb6c3938))
* **file-viewer:** co-locate markdown styles, add Cmd+Shift+V preview toggle ([#571](https://github.com/utensils/claudette/issues/571)) ([4282918](https://github.com/utensils/claudette/commit/4282918ccb324e16139dff9b71e5d4e14df345a2))
* **git:** create workspace branches with no upstream ([#559](https://github.com/utensils/claudette/issues/559)) ([2837cce](https://github.com/utensils/claudette/commit/2837cce555c87ff2b78846e317a9b8998b47b6f5))
* handle workspace name collisions ([#591](https://github.com/utensils/claudette/issues/591)) ([1caed93](https://github.com/utensils/claudette/commit/1caed9385400dea14799c2c675ddf086ce66b281))
* persist diff selection and chat drafts across workspace switches ([#543](https://github.com/utensils/claudette/issues/543)) ([dc30ebb](https://github.com/utensils/claudette/commit/dc30ebb16adfa440f65a8b266f5045925e5abdee))
* **terminal:** align xterm.js mouse coords with rendered rows ([#550](https://github.com/utensils/claudette/issues/550)) ([e34c392](https://github.com/utensils/claudette/commit/e34c392ba15f0b50a3a1acdf5db4f229c3a84b84))
* **terminal:** stop stealing focus from chat composer when agent finishes ([#549](https://github.com/utensils/claudette/issues/549)) ([3f5d38b](https://github.com/utensils/claudette/commit/3f5d38b033f28f00a51a6da1b2e4894595da7f68))
* **tray:** clear workspace attention server-side on menu click ([#594](https://github.com/utensils/claudette/issues/594)) ([6c4cb71](https://github.com/utensils/claudette/commit/6c4cb7135955c5fd30ee1edf17d62d79030bbe67))
* **ui:** clear active file tab when selecting Changes diff entry ([#573](https://github.com/utensils/claudette/issues/573)) ([#578](https://github.com/utensils/claudette/issues/578)) ([386b346](https://github.com/utensils/claudette/commit/386b3469cce903d2d1b71a92016494eea2e47704))
* **workspace:** level-triggered branch reconcile so a stale sidebar self-heals ([#540](https://github.com/utensils/claudette/issues/540)) ([cc2c9b2](https://github.com/utensils/claudette/commit/cc2c9b28584165ffc979fab8023ea0712f61f466))
* **workspace:** preserve branch names for imported workspaces ([#553](https://github.com/utensils/claudette/issues/553)) ([624820a](https://github.com/utensils/claudette/commit/624820abf5e8b09865ba5e83fe8e4e3e1209410b))


### Performance Improvements

* **workspace:** apply optimistic UI when archiving ([#595](https://github.com/utensils/claudette/issues/595)) ([9c0e33b](https://github.com/utensils/claudette/commit/9c0e33bce3d13fcd7035568c4492ddee5e110319))

## [0.21.0](https://github.com/utensils/claudette/compare/v0.20.1...v0.21.0) (2026-04-30)


### Features

* **agent-mcp:** broaden send_to_user to CSV/JSON/Markdown with type-aware previews ([#465](https://github.com/utensils/claudette/issues/465)) ([923600b](https://github.com/utensils/claudette/commit/923600bf48d920d4f3e63ae04d1fe27708e657f6))
* **chat:** add hover copy button to user messages ([#530](https://github.com/utensils/claudette/issues/530)) ([534aaaf](https://github.com/utensils/claudette/commit/534aaafe09662c33cace5aaa8d37abd7aca39158))
* **chat:** inline plan refinement via feedback textarea ([#475](https://github.com/utensils/claudette/issues/475)) ([2b12e4e](https://github.com/utensils/claudette/commit/2b12e4e94662428c4925e6f992f38b248c9983e9))
* **diff:** add markdown preview with mermaid for changed .md files ([#493](https://github.com/utensils/claudette/issues/493)) ([8226c3a](https://github.com/utensils/claudette/commit/8226c3a3677b5475a031b457991c266e951789cc))
* **diff:** syntax highlighting in diff view ([#352](https://github.com/utensils/claudette/issues/352)) ([57c8bec](https://github.com/utensils/claudette/commit/57c8bec720c8d6af5a5bdafffda8fbcb77653622))
* **i18n:** add Brazilian Portuguese (pt-BR) translation ([#527](https://github.com/utensils/claudette/issues/527)) ([5bcc998](https://github.com/utensils/claudette/commit/5bcc99804479f2fb204803b108eaee14c6c7e8ff))
* **i18n:** add Chinese (Simplified) translation ([#531](https://github.com/utensils/claudette/issues/531)) ([4bde94f](https://github.com/utensils/claudette/commit/4bde94f39f4d99c00de6996227421fefc9b66f3b))
* **i18n:** add Japanese (ja) translation ([#529](https://github.com/utensils/claudette/issues/529)) ([2a1da58](https://github.com/utensils/claudette/commit/2a1da58aefe399fcb1b67df084fddfb0b5c8a8cf))
* **i18n:** complete Spanish translation for chat, modals, and settings ([#526](https://github.com/utensils/claudette/issues/526)) ([badbba6](https://github.com/utensils/claudette/commit/badbba68680e116f3aa993666da9358e2bce2bd0))
* **i18n:** introduce i18next internationalization infrastructure (phase 1) ([#457](https://github.com/utensils/claudette/issues/457)) ([12e1092](https://github.com/utensils/claudette/commit/12e109212b0d3b59ac5dd2e3ef75bbdf6f7c074a))
* **i18n:** localize tray, notifications, and quit dialog (phase 2) ([#523](https://github.com/utensils/claudette/issues/523)) ([4a2162e](https://github.com/utensils/claudette/commit/4a2162e1db705791481408a7ba38663168e91953))
* **settings:** add theme mode selector with light/dark/system sync ([#369](https://github.com/utensils/claudette/issues/369)) ([a5cf5a5](https://github.com/utensils/claudette/commit/a5cf5a50fc88e7620ae52f4ecd88ea6fa9c4b5d1))


### Bug Fixes

* **build:** generate bundle icons at build time + non-nix mise toolchain ([#535](https://github.com/utensils/claudette/issues/535)) ([55c01e5](https://github.com/utensils/claudette/commit/55c01e540cebdb0dce541a88ae7f5d0b5b3eca89))
* **chat:** scope blockToolMapRef by session id ([#484](https://github.com/utensils/claudette/issues/484)) ([#501](https://github.com/utensils/claudette/issues/501)) ([7ca6178](https://github.com/utensils/claudette/commit/7ca6178c2c4cf4375d056147bb9a67ce9aa740b9))
* **chat:** surface env-provider trust errors as system message before agent spawn ([#479](https://github.com/utensils/claudette/issues/479)) ([690cae2](https://github.com/utensils/claudette/commit/690cae2f6e940bf7d951102b4f83e62525cfd9e9))
* **db:** surface unknown enum values instead of silent fallback ([#515](https://github.com/utensils/claudette/issues/515)) ([764c8f4](https://github.com/utensils/claudette/commit/764c8f44a845ea5791cfb6ba7b35a77d1f1aaccc))
* **i18n:** refactor modal warnings to use Trans ([#529](https://github.com/utensils/claudette/issues/529) follow-up) ([#532](https://github.com/utensils/claudette/issues/532)) ([98fc4af](https://github.com/utensils/claudette/commit/98fc4af51706188ec0f1ec0299343e1c1048cc3e))
* interrupt CPU-bound Lua plugins ([#494](https://github.com/utensils/claudette/issues/494)) ([3c5c4bc](https://github.com/utensils/claudette/commit/3c5c4bcccd746eec59d4dfd97bfcc2ec7a37c410))
* **metrics:** use system local timezone for dashboard date windows ([#512](https://github.com/utensils/claudette/issues/512)) ([bc3365d](https://github.com/utensils/claudette/commit/bc3365df2dba856f2ef67befd5c3c2d2115b9dc6))
* **theme:** guard OS theme change handler against async race, add findTheme tests ([#481](https://github.com/utensils/claudette/issues/481)) ([3efbcd5](https://github.com/utensils/claudette/commit/3efbcd510d92adc21a57576a76c28a6ad1e318ed))
* **updater:** reset manual-check button when an update is available ([#514](https://github.com/utensils/claudette/issues/514)) ([1eec360](https://github.com/utensils/claudette/commit/1eec360f28ab608da8f5d408252dc80524792471))


### Performance Improvements

* **branch-refresh:** focus-aware polling and bounded startup git probes ([#502](https://github.com/utensils/claudette/issues/502)) ([4041f92](https://github.com/utensils/claudette/commit/4041f9280c4af09a92d3d458cda4fa907641468c))
* **plugins:** eliminate cold-start delay on plugin settings page ([#534](https://github.com/utensils/claudette/issues/534)) ([e1b8f4c](https://github.com/utensils/claudette/commit/e1b8f4c72dd1e11d6057657d7c64e0042d3d89de))

## [0.20.1](https://github.com/utensils/claudette/compare/v0.20.0...v0.20.1) (2026-04-28)


### Bug Fixes

* **chat:** show paths relative to workspace root in tool usage rows ([#471](https://github.com/utensils/claudette/issues/471)) ([523c71b](https://github.com/utensils/claudette/commit/523c71b16456a70e9947866bca136125de4133c2))
* **settings:** show all fonts in both pickers and add search ([#474](https://github.com/utensils/claudette/issues/474)) ([c9af8ed](https://github.com/utensils/claudette/commit/c9af8ed09d929b9b4491b336fcdcb3a85ae9412c))
* **sidebar:** key Tasks panel by active sessionId, not workspaceId ([#472](https://github.com/utensils/claudette/issues/472)) ([e53870d](https://github.com/utensils/claudette/commit/e53870d557c3e7fe65ccad7390c94328963bf215))

## [0.20.0](https://github.com/utensils/claudette/compare/v0.19.0...v0.20.0) (2026-04-27)


### Features

* add SVG logo asset ([cf590fd](https://github.com/utensils/claudette/commit/cf590fd7d4328c10534712a2a009aef4ae62eb20))
* **chat:** agent-authored inline attachments via in-process MCP bridge ([#431](https://github.com/utensils/claudette/issues/431)) ([ee348ce](https://github.com/utensils/claudette/commit/ee348ceb8781a8002c861f44b35b6e5b0b07558f))
* **chat:** Cmd/Ctrl+F to search the current workspace chat session ([#447](https://github.com/utensils/claudette/issues/447)) ([bdb89f3](https://github.com/utensils/claudette/commit/bdb89f34cfc3222164f4655ef4a56c92fbb4b07f))
* **chat:** hide 1M context models when CLAUDE_CODE_DISABLE_1M_CONTEXT is set ([#440](https://github.com/utensils/claudette/issues/440)) ([6588f1e](https://github.com/utensils/claudette/commit/6588f1ebf5d2577e0d826aa22594a670d7286d58))
* **chat:** multi-session tabs per workspace ([#306](https://github.com/utensils/claudette/issues/306)) ([abd79d7](https://github.com/utensils/claudette/commit/abd79d720e673efa3a05fae0ff995ed8fa32296b))
* **chat:** pin frequently-used slash commands in the composer ([#401](https://github.com/utensils/claudette/issues/401)) ([0104498](https://github.com/utensils/claudette/commit/0104498ed6c05e22e6e94b4fa67717cd55a29c48))
* **chat:** voice input providers (apple speech + bundled whisper) ([#438](https://github.com/utensils/claudette/issues/438)) ([a1d5a61](https://github.com/utensils/claudette/commit/a1d5a61d38a697dd89e3f8c67c6b39cd2d955951))
* **db:** tolerate "already exists" errors in migration runner ([#448](https://github.com/utensils/claudette/issues/448)) ([b53e431](https://github.com/utensils/claudette/commit/b53e431db3f57da84e4749f5d278636d3c25bc9a))
* **diff:** open file diffs as tabs alongside chat sessions ([#456](https://github.com/utensils/claudette/issues/456)) ([a4ac215](https://github.com/utensils/claudette/commit/a4ac215f3a968e0d02238dcf61e5b55dbb943f17))
* **release:** add native linux-aarch64 builds ([#445](https://github.com/utensils/claudette/issues/445)) ([77e95f9](https://github.com/utensils/claudette/commit/77e95f9abb69819a4c779ce76ab2192b87d656ce))
* **server:** thread env-provider ResolvedEnv through remote handler ([#446](https://github.com/utensils/claudette/issues/446)) ([9a1ab96](https://github.com/utensils/claudette/commit/9a1ab968fc7114c1ad11234aeb0d87699a746d61))
* **sidebar:** discard changes from unstaged + untracked files ([#444](https://github.com/utensils/claudette/issues/444)) ([c333258](https://github.com/utensils/claudette/commit/c3332581e35258f51b8db8b6cfff547c9edf044f))
* **terminal:** polling-based command indicator + cleaner PTY lifecycle ([#466](https://github.com/utensils/claudette/issues/466)) ([51f8080](https://github.com/utensils/claudette/commit/51f8080fd0f7f74ecad9c0c0801aaed41a121945))


### Bug Fixes

* **chat:** attachment context menus + SVG lightbox preview ([#434](https://github.com/utensils/claudette/issues/434)) ([7b2e709](https://github.com/utensils/claudette/commit/7b2e709399fe8e3e689dba5bdcae827b5e95405e))
* **chat:** clean code-block selection rectangle ([#435](https://github.com/utensils/claudette/issues/435)) ([5b9c1b6](https://github.com/utensils/claudette/commit/5b9c1b66015205252d106e08119229d6fb61eeaa))
* **chat:** eliminate stair-step code block selection + add copy button ([5b9c1b6](https://github.com/utensils/claudette/commit/5b9c1b66015205252d106e08119229d6fb61eeaa))
* **chat:** expand trailing tool-call summaries by toggling under sessionId ([#464](https://github.com/utensils/claudette/issues/464)) ([10f2312](https://github.com/utensils/claudette/commit/10f23122378607f388b477dc02eaa5deed0e7982))
* **chat:** restore drag-and-drop attachments via promise chain fix and HTML5 fallback ([#452](https://github.com/utensils/claudette/issues/452)) ([47af807](https://github.com/utensils/claudette/commit/47af8076bf69075862f57a4c29ddad3b9e8faa19))
* **ci:** prefix nightly short SHA with 'g' to keep version SemVer-valid ([#451](https://github.com/utensils/claudette/issues/451)) ([20001f8](https://github.com/utensils/claudette/commit/20001f87d2ce421ea4480aad6bf598991b847bb9))
* input tweak ([8f79887](https://github.com/utensils/claudette/commit/8f79887e2468221557e65477103bcaa8aad09f48))
* **terminal:** restore workspace sidebar command indicator after split-pane refactor ([#460](https://github.com/utensils/claudette/issues/460)) ([72bc306](https://github.com/utensils/claudette/commit/72bc3067fabd03246925fca548b7efd1c8c5a678)), closes [#459](https://github.com/utensils/claudette/issues/459)
* **updater:** fall back to previous nightly when manifest is broken ([#454](https://github.com/utensils/claudette/issues/454)) ([b5568a5](https://github.com/utensils/claudette/commit/b5568a5ff94685adfce4bae5149c07d7d4c63d19))
* **updater:** keep nightly available during in-progress builds ([#443](https://github.com/utensils/claudette/issues/443)) ([344bc8f](https://github.com/utensils/claudette/commit/344bc8f30d921d9feba80481d405ea0b49a5a1f0))
* **updater:** rewrite latest.json URLs after staging promote ([#449](https://github.com/utensils/claudette/issues/449)) ([ab6171f](https://github.com/utensils/claudette/commit/ab6171fa4631c28958500b303b3ca7753499f943))
* **updater:** unstick nightly install via CI URL fix and visible error UI ([#453](https://github.com/utensils/claudette/issues/453)) ([27c63f2](https://github.com/utensils/claudette/commit/27c63f278cb16a8286f3c20b2e797b8972793720))


### Performance Improvements

* **chat:** workerize Shiki + memoize markdown render path ([#439](https://github.com/utensils/claudette/issues/439)) ([2c0628d](https://github.com/utensils/claudette/commit/2c0628dfb005597932a1af430d1f16c92632893d))

## [0.19.0](https://github.com/utensils/claudette/compare/v0.18.0...v0.19.0) (2026-04-25)


### Features

* **chat:** lightbox preview for attachment images (single-click → full-size) ([#425](https://github.com/utensils/claudette/issues/425)) ([c92bf03](https://github.com/utensils/claudette/commit/c92bf03b1ccb8994f7ee93e771cb1bba213e5923))
* **env-direnv:** honor DIRENV_WATCHES + slow nix-devshell test ([#415](https://github.com/utensils/claudette/issues/415)) ([6d59f6a](https://github.com/utensils/claudette/commit/6d59f6a41b557772ac659a1fe984c605b53c5a6c))
* **env-provider:** reactive fs-watcher invalidation + proactive warmup on repo add ([#416](https://github.com/utensils/claudette/issues/416)) ([99b857a](https://github.com/utensils/claudette/commit/99b857a7e6ec4c538f9c1e4fcfa3b1d40ef48a5d))
* persist SCM status to SQLite for instant display on app reload ([#381](https://github.com/utensils/claudette/issues/381)) ([aa09c2a](https://github.com/utensils/claudette/commit/aa09c2acd12b9b169690bcc63fe8ce51db05bf2f))
* **plugins:** plugin runtime kinds + env-provider system + repo-level env panel ([#406](https://github.com/utensils/claudette/issues/406)) ([6f356b3](https://github.com/utensils/claudette/commit/6f356b37f6e1340195b2035376cca8db670fa429))
* **repo:** add per-repository base branch and default remote settings ([#386](https://github.com/utensils/claudette/issues/386)) ([f4f69cd](https://github.com/utensils/claudette/commit/f4f69cd74cd49b74dbe6edb078e78f74d7fdf458))
* **settings:** auto-delete workspace record when branch is deleted on archive ([#400](https://github.com/utensils/claudette/issues/400)) ([6aa8fd3](https://github.com/utensils/claudette/commit/6aa8fd37c57e1877f7ba63f0483ca04b975b9525))
* **sidebar:** show badge-check icon when agent completes work ([#391](https://github.com/utensils/claudette/issues/391)) ([060b6da](https://github.com/utensils/claudette/commit/060b6daf3c03c38ba42cab4b11d1b97fd7aa0868))
* **terminal:** add split-pane support to the integrated terminal ([#414](https://github.com/utensils/claudette/issues/414)) ([723fb96](https://github.com/utensils/claudette/commit/723fb96c0e6bc1f2bd869e2bf85f851b7169931d))
* **ux:** dialog with install guidance when a required CLI is missing ([#417](https://github.com/utensils/claudette/issues/417)) ([0e7f075](https://github.com/utensils/claudette/commit/0e7f075c080835f99a56b47ebea69bbf3089f46b))
* **windows:** native Windows support + CI/CD ([#383](https://github.com/utensils/claudette/issues/383)) ([74a019d](https://github.com/utensils/claudette/commit/74a019db2e828e65ac070d4ea5aa9ea3f711c72f))


### Bug Fixes

* **chat:** preserve session context when stopping agent ([#398](https://github.com/utensils/claudette/issues/398)) ([81c5b6e](https://github.com/utensils/claudette/commit/81c5b6eaf2382f4cea2b688e45a980f2108f097e))
* **chat:** remove horizontal scrollbar from input composer ([#404](https://github.com/utensils/claudette/issues/404)) ([5b8e737](https://github.com/utensils/claudette/commit/5b8e737e5e24bbe4b10a5c49c5faba1df306730e)), closes [#388](https://github.com/utensils/claudette/issues/388)
* **chat:** show rollback footer for plain turns ([#426](https://github.com/utensils/claudette/issues/426)) ([acc1de9](https://github.com/utensils/claudette/commit/acc1de9448ce782e2d4a57ee0d38296d928bc47a))
* **notifications:** defer attention notify until UI has the prompt event ([#402](https://github.com/utensils/claudette/issues/402)) ([e4d0fe1](https://github.com/utensils/claudette/commit/e4d0fe1818ee0a5441f24f2a880ac258ee09fd5f))
* **notifications:** prevent active sound pack from resetting on restart ([#384](https://github.com/utensils/claudette/issues/384)) ([37ccfd9](https://github.com/utensils/claudette/commit/37ccfd955e6fa8f88bd45a0f1f194ba98c9c60c2))
* **repository:** show friendly message on duplicate repo path ([#393](https://github.com/utensils/claudette/issues/393)) ([4165c08](https://github.com/utensils/claudette/commit/4165c083924c02916958bd17ac641acb4cf582bc))
* **sidebar:** persist external branch renames to DB and refresh on select ([#405](https://github.com/utensils/claudette/issues/405)) ([f5c1aef](https://github.com/utensils/claudette/commit/f5c1aefe0bcbbb1356e03bf98f340447662625b0))
* **sidebar:** remove deleted workspace from sidebar and handle re-delete gracefully ([#377](https://github.com/utensils/claudette/issues/377)) ([dad6842](https://github.com/utensils/claudette/commit/dad68427722c41fc7aef902936978af60ad97d39))
* **terminal:** trim trailing whitespace per line on terminal copy ([#403](https://github.com/utensils/claudette/issues/403)) ([1b7d72e](https://github.com/utensils/claudette/commit/1b7d72ecbf0c46786c60329e1a589fc934351a8d))
* **usage:** eliminate stale error flash on first open ([#394](https://github.com/utensils/claudette/issues/394)) ([12aa9ec](https://github.com/utensils/claudette/commit/12aa9ec5f4ecc0298e285d035e13fc78438986f8))

## [0.18.0](https://github.com/utensils/claudette/compare/v0.17.0...v0.18.0) (2026-04-23)


### Features

* **chat:** add /compact slash command and fix context meter buttons ([#363](https://github.com/utensils/claudette/issues/363)) ([1492973](https://github.com/utensils/claudette/commit/149297377353158364cee8a8c9053c991537ec3c))
* **chat:** live token usage and compaction indicator ([#361](https://github.com/utensils/claudette/issues/361)) ([5416e2d](https://github.com/utensils/claudette/commit/5416e2d10243cdb3001a350499466be625eafc68))
* **notifications:** add OpenPeon community sound pack support ([#357](https://github.com/utensils/claudette/issues/357)) ([37f8c37](https://github.com/utensils/claudette/commit/37f8c37e0cd2d6b37efb5c3e841807fedf0b9b47))
* **sidebar:** allow renaming workspaces via double-click ([#367](https://github.com/utensils/claudette/issues/367)) ([054275e](https://github.com/utensils/claudette/commit/054275e15d347ec81d7d7731cf09244122779585))
* **site:** add homepage Screenshots section with dashboard and chat views ([#349](https://github.com/utensils/claudette/issues/349)) ([d14e8fc](https://github.com/utensils/claudette/commit/d14e8fc3e83e55d686286e18e3feea3bfc564977))
* **terminal:** open clicked URLs in the default browser ([#358](https://github.com/utensils/claudette/issues/358)) ([916e281](https://github.com/utensils/claudette/commit/916e2811053b1c69f553896ee2841b1c6e0e94a0)), closes [#356](https://github.com/utensils/claudette/issues/356)


### Bug Fixes

* **chat:** elapsed timer resets when switching between workspaces ([#364](https://github.com/utensils/claudette/issues/364)) ([5ec28ab](https://github.com/utensils/claudette/commit/5ec28abc16715342cb464c5bef7068736280d37a))
* **metrics:** exclude deleted repos from leaderboard via INNER JOIN ([#370](https://github.com/utensils/claudette/issues/370)) ([6dceb61](https://github.com/utensils/claudette/commit/6dceb61e52664a87ea52afcfe8f89153b45dd259))
* **metrics:** resize heatmap grid row correctly on window maximize ([#375](https://github.com/utensils/claudette/issues/375)) ([462b15f](https://github.com/utensils/claudette/commit/462b15f8d3b92e2f8cdc3da0c8a8276893b7100a))
* **settings:** constrain radio label click area to content width ([#366](https://github.com/utensils/claudette/issues/366)) ([0641bd9](https://github.com/utensils/claudette/commit/0641bd958a55e7fd5ad4bb4c60899fc8f394c259)), closes [#327](https://github.com/utensils/claudette/issues/327)
* **sidebar:** prevent filter menu selects from overflowing sidebar ([#376](https://github.com/utensils/claudette/issues/376)) ([8dd825c](https://github.com/utensils/claudette/commit/8dd825c49f063f7bf84fe3f5230df873d572bec6))
* update expired Discord invite links to permanent URL ([#368](https://github.com/utensils/claudette/issues/368)) ([2905dd8](https://github.com/utensils/claudette/commit/2905dd8a99bd9dd4385aed9172df87ca9d8d16c5))

## [0.17.0](https://github.com/utensils/claudette/compare/v0.16.0...v0.17.0) (2026-04-22)


### Features

* **chat:** honor 200k context window for non-[1m] model variants ([#343](https://github.com/utensils/claudette/issues/343)) ([4ef17ad](https://github.com/utensils/claudette/commit/4ef17ad0f0645f804ff5d71366ec44727b17fff9))
* **chat:** redesign composer with pill toolbar and segmented context meter ([#348](https://github.com/utensils/claudette/issues/348)) ([75113ba](https://github.com/utensils/claudette/commit/75113ba9dc6e62430b1a949e4de52a5236b73c6e))
* **chat:** support drag-and-drop and attachment of any file type ([#339](https://github.com/utensils/claudette/issues/339)) ([9251e7a](https://github.com/utensils/claudette/commit/9251e7a5a0f2ad5a798f1cd91990f57c3ad6afcb))
* **metrics:** show total tokens on workspace cards with hover tooltips ([#346](https://github.com/utensils/claudette/issues/346)) ([027e8c0](https://github.com/utensils/claudette/commit/027e8c050503c02bc425d0afd809fbd5ae4c76fc))
* **metrics:** token usage analytics on dashboard ([#345](https://github.com/utensils/claudette/issues/345)) ([3859189](https://github.com/utensils/claudette/commit/3859189b0f8d9d416b7ab78b7542c17e0e75b045))
* **notifications:** per-event notification sound selection ([#333](https://github.com/utensils/claudette/issues/333)) ([2a1d9e5](https://github.com/utensils/claudette/commit/2a1d9e500ff7fb32a6fe4d77a70b524cd28f9f38))
* **sidebar:** sort workspaces by SCM status in repo-grouped view ([#350](https://github.com/utensils/claudette/issues/350)) ([dd6d50b](https://github.com/utensils/claudette/commit/dd6d50b1e389037875caf839bfaef49284d527b9))


### Bug Fixes

* **chat:** gate first-turn auto-rename on persistent workspace flag ([#344](https://github.com/utensils/claudette/issues/344)) ([b3994ce](https://github.com/utensils/claudette/commit/b3994ce78dacb577a3370e4f7a85458e6f171a7f))
* **diff:** don't overflow individual diff lines ([#347](https://github.com/utensils/claudette/issues/347)) ([f2cba74](https://github.com/utensils/claudette/commit/f2cba740f800dada63a078bed6ed417b4997dfba))
* **settings:** prevent Escape from closing settings UI ([#338](https://github.com/utensils/claudette/issues/338)) ([8264c8b](https://github.com/utensils/claudette/commit/8264c8b2755baf9befb79c3413de1f0489cc1abf))

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
