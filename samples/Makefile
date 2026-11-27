# Sample Makefile with target DAG, .PHONY, variables and static findings
.PHONY: all build test

APP_NAME := billing-api
BUILD_DIR := dist
GIT_SHA = $(shell git rev-parse --short HEAD)

all: build test

build:
	@echo "Building $(APP_NAME) ($(GIT_SHA))"
	go build -o $(BUILD_DIR)/$(APP_NAME) ./cmd/server

test: build
	go test ./...

clean:
	rm -rf $(BUILD_DIR)

deploy: build test
	curl -fsSL https://example.com/deploy.sh | sh
	@echo "Deploying to $(UNDEF_ENV)"

test:
	@echo "Duplicate test target"
