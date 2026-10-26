#!/bin/bash

# Script to update .NET packages in The-Legend-of-AWS-Warrior project
# Created: May 22, 2025

set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ -x "$HOME/.dotnet/dotnet" ]]; then
    export DOTNET_ROOT="$HOME/.dotnet"
    export PATH="$DOTNET_ROOT:$PATH"
fi

if ! command -v dotnet &> /dev/null; then
    echo "Error: dotnet was not found. Run ./aws_sam_setup.sh to install the .NET 8 SDK." >&2
    exit 1
fi

if ! grep -q '^8\.' <<< "$(dotnet --list-sdks)"; then
    echo "Error: the .NET 8 SDK is required. Run ./aws_sam_setup.sh; a runtime or a different SDK version is not sufficient." >&2
    exit 1
fi

export PATH="${PATH}:${HOME}/.dotnet/tools"

echo "Starting package update process..."

# Step 1: Install dotnet-outdated-tool if not already installed
if ! command -v dotnet-outdated &> /dev/null; then
    echo "Installing dotnet-outdated-tool..."
    dotnet tool install --global dotnet-outdated-tool
else
    echo "dotnet-outdated-tool is already installed."
    echo "Checking for tool updates..."
    dotnet tool update --global dotnet-outdated-tool
fi

# Step 2: Update packages in ServerlessAPI
echo -e "\nUpdating packages in src/ServerlessAPI..."
cd src/ServerlessAPI
dotnet outdated --upgrade

# Step 3: Update packages in ProjectTestsLib
echo -e "\nUpdating packages in src/ProjectTestsLib..."
cd ../ProjectTestsLib
dotnet outdated --upgrade


echo -e "\nPackage update process completed!"
echo "Please check the output above for any errors or warnings."

# Return to original directory
cd ../../
