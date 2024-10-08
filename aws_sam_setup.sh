#!/bin/bash

# Download AWS SAM CLI
curl -L -o sam.zip https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip

# Unzip the downloaded file
unzip sam.zip -d sam-installation

# Install AWS SAM CLI
sudo ./sam-installation/install

# Verify the installation
sam --version

# Clean up
rm -rf sam.zip sam-installation
