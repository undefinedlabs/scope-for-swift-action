const core = require('@actions/core');
const exec = require('@actions/exec');
const path = require('path')
const fs = require('fs')
const shell = require('shelljs');

const SCOPE_DSN = 'SCOPE_DSN';

async function run() {
    try {

      var dsn = core.getInput('dsn') || process.env[SCOPE_DSN];
        dsn = 'Hola'
      if (!dsn) {
        throw Error('Cannot find the Scope DSN');
      }

      var sdk = core.getInput('sdk') || 'iphonesimulator';
      var destination = core.getInput('destination') || 'platform=iOS Simulator,name=iPhone 11';

      //Read project
      const workspace  = getWorkspace();
      const xcodeproj = getXCodeProj();

      var projectParameter

      if(workspace) {
          console.log(`Workspace: ${workspace}`);
          projectParameter = '-workspace ' + workspace
      } else if (xcodeproj) {
          console.log(`Project: ${xcodeproj}`);
          projectParameter = '-project ' + xcodeproj
      } else {
          throw Error('Unable to find the workspace or xcodeproj. Please set with.workspace or.xcodeproj');
      }

      const scheme = getScheme(workspace, xcodeproj);
      console.log(`Scheme: ${scheme}`);

      //copy configfile
        let configfileName = 'scopeConfig.xcconfig'
        let scopeDir = '.scope_dir'
        let configFilePath = scopeDir + '/' + configfileName

        if (!fs.existsSync(scopeDir)){
            fs.mkdirSync(scopeDir);
        }
        fs.copyFileSync('dist/'+ configfileName, configFilePath)

        //build for testing
        let buildCommand = 'xcodebuild build-for-testing -xcconfig ' + configFilePath + ' ' + projectParameter +
            ' -scheme ' + scheme + ' -sdk ' + sdk + ' -destination \'' + destination + '\' -derivedDataPath .scope_dir/derived'


        let output = shell.exec(buildCommand, {silent: false})


        console.log(output);

    } catch (error) {
      core.setFailed(error.message);
    }
  }


function getWorkspace() {
    var workspace = core.getInput('workspace')
    if (!workspace) {
        workspace = shell.ls().filter(function(file) { return file.match(/\.xcworkspace$/); })[0]
    }
    return workspace
}

function getXCodeProj() {
    var xcodeproj = core.getInput('xcodeproj')
    if (!xcodeproj) {
        xcodeproj = shell.ls().filter(function(file) { return file.match(/\.xcodeproj/); })[0]
    }
    return xcodeproj
}

function getScheme(workspace, xcodeproj) {
    var scheme = core.getInput('scheme')
    if (!scheme) {
        var command
        if(workspace) {
            command = 'xcodebuild -workspace ' + workspace + ' -list -json'
        } else {
            command = 'xcodebuild -project ' + xcodeproj + ' -list -json'
        }
        const info = JSON.parse(shell.exec(command, {silent: true}).stdout)
        const aux = info.workspace || info.project
        const schemes = aux.schemes
        console.log('find schemes: ' + JSON.stringify(schemes))
        scheme = intelligentSelectScheme(schemes, aux)
    }
    return scheme
}


function intelligentSelectScheme(schemes, workspacePath) {
    if (schemes.length < 1) {
        return null
    }
    const workspaceName = workspacePath.name
    if (schemes.includes(workspaceName)) {
        return workspaceName
    }
    return schemes[0]
}

run()
