.PHONY: setup run

setup:
	mise trust
	mise install
	cd src/ui && mise exec -- bun install
	mise exec -- cargo fetch

run:
	mise exec -- cargo tauri dev
