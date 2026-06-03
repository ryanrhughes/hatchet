PREFIX ?= /usr
BINDIR ?= $(PREFIX)/bin
DATADIR ?= $(PREFIX)/share/hatchet
DESTDIR ?=
BUN ?= bun
OUT ?= dist/hatchet

# Prompt for privilege only for real system installs. Packagers normally set DESTDIR.
SUDO ?= $(shell if [ -z "$(DESTDIR)" ] && [ "$$(id -u)" -ne 0 ] && [ ! -w "$(PREFIX)" ]; then command -v sudo || command -v doas || true; fi)

.PHONY: all build install uninstall clean test typecheck check install-handler local-install

all: build

build:
	$(BUN) build --compile --outfile $(OUT) src/main.ts

install: build
	$(SUDO) install -Dm755 $(OUT) "$(DESTDIR)$(BINDIR)/hatchet"
	$(SUDO) install -d "$(DESTDIR)$(DATADIR)/chrome-extension"
	$(SUDO) cp -a chrome-extension/. "$(DESTDIR)$(DATADIR)/chrome-extension/"
	@echo "Installed hatchet to $(DESTDIR)$(BINDIR)/hatchet"
	@echo "Installed Chrome extension to $(DESTDIR)$(DATADIR)/chrome-extension"

local-install:
	$(MAKE) install PREFIX="$$HOME/.local"

uninstall:
	$(SUDO) rm -f "$(DESTDIR)$(BINDIR)/hatchet"
	$(SUDO) rm -rf "$(DESTDIR)$(DATADIR)"
	@echo "Removed $(DESTDIR)$(BINDIR)/hatchet and $(DESTDIR)$(DATADIR)"

install-handler:
	hatchet --install-handler

clean:
	rm -f $(OUT)

typecheck:
	npx tsc --noEmit

test:
	$(BUN) test

check: typecheck test build
