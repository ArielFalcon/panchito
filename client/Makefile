# panchito — the Go/Bubble Tea control-plane client.
# Pinned to the oapi-codegen version that generated the committed types.
OAPI ?= go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.7.1

.PHONY: gen build test install

# Regenerate the Go contract types from the published OpenAPI artifact. The
# orchestrator owns contract/openapi.json (npm run contract:gen); this vendors it.
gen:
	$(OAPI) -generate types -package contract -o internal/contract/types.gen.go ../contract/openapi.json

build:
	go build ./...

test:
	go test ./...

# Compile and install the standalone `panchito` binary into Go's bin dir
# ($GOBIN, else $GOPATH/bin, else ~/go/bin). Add that dir to PATH and then
# `panchito` launches the app from any terminal — no rebuild per launch.
install:
	go install ./cmd/panchito
	@echo "installed: $$(go env GOBIN 2>/dev/null || echo $$(go env GOPATH)/bin)/panchito"
