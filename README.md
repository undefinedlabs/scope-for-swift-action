![logo](scope_logo.svg)

# Scope for Swift Action

GitHub Action to run your tests automatically instrumented with the [Scope Swift agent](http://home.undefinedlabs.com/goto/swift-agent). It supports Xcode projects as well as Swift Package Manager packages for iOS, macOS or tvOS platforms.

## About Scope

[Scope](https://scope.dev) gives developers production-level visibility on every test for every app – spanning mobile, monoliths, and microservices.

## Usage

1. Set Scope DSN inside Settings > Secrets as `SCOPE_DSN`.

2. Add a step to your GitHub Actions workflow YAML that uses this action:

   ```yaml
   steps:
     - name: Checkout
       uses: actions/checkout@v1
     - name: Scope for Swift
       uses: undefinedlabs/scope-for-swift-action@v1
       with:
         dsn: ${{ secrets.SCOPE_DSN }} #required
   ```

## Configuration

These are the optional parameters of the action:

```yaml
platform: Platform to run: "ios", "macos" or "tvos". By default: "ios"
workspace: .xcworkspace file, if not set, workspace will be autoselected
project:  .xcodeproj file, if not set, project will be autoselected
scheme: Scheme to test, if not set, scheme will be autoselected
configuration: configuration for testing, by default: 'Debug'
sdk:  Sdk used for building, by default: 'iphonesimulator' will be used
destination: destination for testing, by default: 'platform=iOS Simulator,name=iPhone 11'
agentVersion: Version of the Scope agent to use for testing, by default the latest stable
codePath: Enable Codepath functionality, false by default
```
