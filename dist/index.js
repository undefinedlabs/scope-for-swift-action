const core = require('@actions/core');
const exec = require('@actions/exec');
const path = require('path');
const fs = require('fs');
const shell = require('shelljs');

const SCOPE_DSN = 'SCOPE_DSN';
const scopeDir = '.scope_dir';
const derivedDataPath = scopeDir + '/derived';
const xctestDir =  derivedDataPath + '/Build/Products/';
const testrunJson = scopeDir + '/testrun.json';
let dsn;

async function run() {
    try {
      dsn = core.getInput('dsn') || process.env[SCOPE_DSN];
      let sdk = core.getInput('sdk') || 'iphonesimulator';
      let destination = core.getInput('destination') || 'platform=iOS Simulator,name=iPhone 11';

        if (!dsn) {
            throw Error('Cannot find the Scope DSN');
        }

      //Read project
      const workspace  = getWorkspace();
      const xcodeproj = getXCodeProj();

      var projectParameter;

      if(workspace) {
          console.log(`Workspace selected: ${workspace}`);
          projectParameter = '-workspace ' + workspace;
      } else if (xcodeproj) {
          console.log(`Project selected: ${xcodeproj}`);
          projectParameter = '-project ' + xcodeproj;
      } else {
          throw Error('Unable to find the workspace or xcodeproj. Please set with.workspace or.xcodeproj');
      }

      const scheme = getScheme(workspace, xcodeproj);
      console.log(`Scheme selected: ${scheme}`);

      //copy configfile
        let configfileName = 'scopeConfig.xcconfig';

        let configFilePath = scopeDir + '/' + configfileName;

        if (!fs.existsSync(scopeDir)){
            fs.mkdirSync(scopeDir);
        }
        fs.copyFileSync('dist/'+ configfileName, configFilePath);

        //build for testing
        let buildCommand = 'xcodebuild build-for-testing -xcconfig ' + configFilePath + ' ' + projectParameter +
            ' -scheme ' + scheme + ' -sdk ' + sdk + ' -destination \"' + destination + '\" -derivedDataPath ' + derivedDataPath;
        await exec.exec(buildCommand, null, { ignoreReturnCode: true });


        //modify xctestrun with Scope variables
        let testRun = getXCTestRun();
        let plutilExportCommand = 'plutil -convert json -o ' + testrunJson + ' ' + testRun;
        await exec.exec(plutilExportCommand, null, { ignoreReturnCode: true });

        let jsonString = fs.readFileSync(testrunJson, "utf8");
        const testTargets = JSON.parse(jsonString);

        Object.keys(testTargets).forEach(function (name,index,array) {
            if( name.charAt(0) != '_' ) {
                insertEnvVariables(testRun, name)
            }
        });

        //run tests
        let testCommand = 'xcodebuild test-without-building -xctestrun ' + testRun + ' -destination \"' + destination + '\"';
        await exec.exec(testCommand, null, { ignoreReturnCode: true });
    } catch (error) {
      core.setFailed(error.message);
    }
  }


function getWorkspace() {
    let workspace = core.getInput('workspace');
    if (!workspace) {
        workspace = shell.ls().filter(function(file) { return file.match(/\.xcworkspace$/); })[0];
    }
    return workspace
}

function getXCodeProj() {
    let xcodeproj = core.getInput('xcodeproj');
    if (!xcodeproj) {
        xcodeproj = shell.ls().filter(function(file) { return file.match(/\.xcodeproj/); })[0];
    }
    return xcodeproj;
}

function getScheme(workspace, xcodeproj) {
    let scheme = core.getInput('scheme');
    if (!scheme) {
        let command;
        if(workspace) {
            command = 'xcodebuild -workspace ' + workspace + ' -list -json';
        } else {
            command = 'xcodebuild -project ' + xcodeproj + ' -list -json';
        }
        const info = JSON.parse(shell.exec(command, {silent: true}).stdout);
        const aux = info.workspace || info.project;
        const schemes = aux.schemes;
        console.log('Available schemes: ' + JSON.stringify(schemes));
        scheme = intelligentSelectScheme(schemes, aux);
    }
    return scheme
}

function getXCTestRun() {
    const testrun = shell.ls(xctestDir).filter(function(file) { return file.match(/\.xctestrun$/); })[0];
    return xctestDir + testrun
}

function insertEnvVariables( file, target) {
    //insertEnvVariable('SCOPE_DSN', '\'$(SCOPE_DSN)\'', file, target );
    insertEnvVariable('SCOPE_DSN', '\"' + dsn + '\"', file, target );
    insertEnvVariable('SCOPE_COMMIT_SHA','\"$(SCOPE_COMMIT_SHA)\"', file, target );
    insertEnvVariable('SCOPE_SOURCE_ROOT','\"$(SCOPE_SOURCE_ROOT)\"', file, target );
    insertEnvVariable('GITHUB_REPOSITORY','\"$(GITHUB_REPOSITORY)\"', file, target );
    insertEnvVariable('SCOPE_COMMIT_SHA','\"$(SCOPE_COMMIT_SHA)\"', file, target );
    insertEnvVariable('SCOPE_INSTRUMENTATION_HTTP_PAYLOADS', "YES", file, target );
    insertEnvVariable('SCOPE_SET_GLOBAL_TRACER', "YES", file, target );
}

function insertEnvVariable( name, value, file, target) {
    let insertCommand = 'plutil -replace \"' + target + '.TestingEnvironmentVariables.' + name + '\" -string ' + value + ' ' + file;
    exec.exec(insertCommand, null, { ignoreReturnCode: true });
}


function intelligentSelectScheme(schemes, workspacePath) {
    if (schemes.length < 1) {
        return null
    }
    const workspaceName = workspacePath.name;
    if (schemes.includes(workspaceName)) {
        return workspaceName
    }
    return schemes[0]
}

run();
