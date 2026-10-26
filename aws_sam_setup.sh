#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
    echo "Error: this setup script supports x86_64 Linux only." >&2
    exit 1
fi

for dependency in curl unzip tar; do
    if ! command -v "$dependency" &> /dev/null; then
        echo "Error: $dependency is required. On Ubuntu, run: sudo apt-get install ca-certificates curl unzip tar" >&2
        exit 1
    fi
done

if (( EUID != 0 )) && ! command -v sudo &> /dev/null; then
    echo "Error: sudo is required to install AWS SAM CLI." >&2
    exit 1
fi

setup_dir="$(mktemp -d)"
trap 'rm -rf -- "$setup_dir"' EXIT

if [[ -x "$HOME/.dotnet/dotnet" ]]; then
    export DOTNET_ROOT="$HOME/.dotnet"
    export PATH="$DOTNET_ROOT:$PATH"
fi

sdk_versions=""
if command -v dotnet &> /dev/null; then
    sdk_versions="$(dotnet --list-sdks)"
fi

if ! grep -q '^8\.' <<< "$sdk_versions"; then
    echo "Installing the .NET 8 SDK..."
    curl --fail --show-error --location \
        https://dot.net/v1/dotnet-install.sh -o "$setup_dir/dotnet-install.sh"
    bash "$setup_dir/dotnet-install.sh" --channel 8.0 --install-dir "$HOME/.dotnet" --no-path
    export DOTNET_ROOT="$HOME/.dotnet"
    export PATH="$DOTNET_ROOT:$PATH"
fi

sdk_versions="$(dotnet --list-sdks)"
if ! grep -q '^8\.' <<< "$sdk_versions"; then
    echo "Error: .NET 8 SDK installation could not be verified." >&2
    exit 1
fi
printf '%s\n' "$sdk_versions"

echo "Installing AWS SAM CLI..."
curl --fail --show-error --location \
    https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip \
    -o "$setup_dir/sam.zip"
unzip -q "$setup_dir/sam.zip" -d "$setup_dir/sam-installation"

if (( EUID == 0 )); then
    "$setup_dir/sam-installation/install" --update
else
    sudo "$setup_dir/sam-installation/install" --update
fi

/usr/local/bin/sam --version
echo "Setup completed successfully."
if [[ -x "$HOME/.dotnet/dotnet" ]]; then
    echo 'For direct dotnet commands in your shell, run (or add to ~/.bashrc):'
    echo 'export DOTNET_ROOT="$HOME/.dotnet"'
    echo 'export PATH="$DOTNET_ROOT:$HOME/.dotnet/tools:$PATH"'
fi
