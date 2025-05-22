#!/bin/bash

# Script to update .NET packages in The-Legend-of-AWS-Warrior project
# Created: May 22, 2025

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
