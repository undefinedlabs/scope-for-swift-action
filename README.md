![logo](scope_logo.svg)

# Scope for iOS Action

GitHub Action to run your tests automatically instrumented with the [Scope iOS agent](http://home.undefinedlabs.com/goto/ios-agent).

## About Scope

[Scope](https://scope.dev) gives developers production-level visibility on every test for every app – spanning mobile, monoliths, and microservices.

## Usage

1. Set Scope DSN inside Settings > Secrets as `SCOPE_DSN`.
2. Add a step to your GitHub Actions workflow YAML that uses this action:
