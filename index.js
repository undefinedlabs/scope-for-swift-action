const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const fetch = require("node-fetch");
const fs = require("fs");
const semver = require("semver");
const os = require("os");
const path = require("path");

const temp = os.tmpdir();
const SCOPE_DSN = "SCOPE_DSN";
const scopeDir = temp + "/.scope_dir";
const derivedDataPath = scopeDir + "/derived";
const xctestDir = derivedDataPath + "/Build/Products/";
const testrunJson = scopeDir + "/testrun.json";

const scope_ios_path = "/scopeAgent/ios";
const scope_macos_path = "/scopeAgent/mac";
const scope_tvos_path = "/scopeAgent/tvos";

let envVars = Object.assign({}, process.env);

async function run() {
  try {
    let dsn = core.getInput("dsn") || process.env[SCOPE_DSN];
    while (dsn.charAt(dsn.length - 1) == "/") {
      dsn = dsn.substring(0, dsn.length - 1);
    }
    if (dsn) {
      envVars[SCOPE_DSN] = dsn;
    }

    let platform = core.getInput("platform") || "ios";
    platform = platform.toLowerCase();

    const scopeFrameworkPath = getPathForPlatform(platform);
    const scopeFrameworkToolsPath = getToolsPathForPlatform(platform);

    const sdk = core.getInput("sdk") || getSDKForPlatform(platform);
    const destination =
      core.getInput("destination") || getDestinationForPlatform(platform);
    const configuration = core.getInput("configuration") || "Debug";
    const agentVersion = core.getInput("agentVersion");
    const codePathEnabled = core.getInput("codePath") === "true";
    const extraParameters = core.getInput("extraParameters") || "";

    if (codePathEnabled) {
      //If project uses testplan force use of code coverage
      let file_list = recFindByExt(".", "xctestplan");
      for (let testPlanFile of file_list) {
        await deleteLinesContaining(testPlanFile, "codeCoverage");
      }
    }

    //Create folder to store files
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir);
    }

    //Read project
    const workspace = await getWorkspace();
    let xcodeproj = await getXCodeProj();
    var projectParameter;

    if (workspace) {
      console.log(`Workspace selected: ${workspace}`);
      projectParameter = "-workspace " + `"${workspace}"`;
    } else if (xcodeproj) {
      console.log(`Project selected: ${xcodeproj}`);
      projectParameter = "-project " + `"${xcodeproj}"`;
    } else if (fs.existsSync("Package.swift")) {
      if (core.getInput("forceSPM") === "true") {
        await swiftPackageRun(extraParameters, codePathEnabled, agentVersion);
        return;
      } else {
        xcodeproj = await generateProjectFromSPM();
        projectParameter = "-project " + `"${xcodeproj}"`;
      }
    } else {
      core.setFailed(
        "Unable to find workspace, project or Swift package file. Please set with workspace or xcodeproj"
      );
    }

    const scheme = await getScheme(workspace, xcodeproj);
    console.log(`Scheme selected: ${scheme}`);

    //copy configfile
    const configfileName = "scopeConfig.xcconfig";

    const configFilePath = scopeDir + "/" + configfileName;

    createXCConfigFile(configFilePath, scopeFrameworkPath);

    //download scope
    await downloadLatestScope(agentVersion);

    let codeCoverParam = "";
    if (codePathEnabled) {
      codeCoverParam = "-enableCodeCoverage YES";
    }
    //build for testing
    let buildCommand =
      "xcodebuild build-for-testing " +
      codeCoverParam +
      " -xcconfig " +
      configFilePath +
      " " +
      projectParameter +
      " -configuration " +
      configuration +
      " -scheme " +
      `"${scheme}"` +
      " -sdk " +
      sdk +
      " -derivedDataPath " +
      derivedDataPath +
      " -destination " +
      `"${destination}" ` +
      extraParameters;
    const result = await exec.exec(buildCommand, null, null);

    uploadSymbols(projectParameter, dsn, scopeFrameworkToolsPath);

    //Fol all testruns that are configured
    let testRuns = await getXCTestRuns();
    let testError;

    for (const testRun of testRuns) {
      //modify xctestrun with Scope variables

      let plutilExportCommand =
        "plutil -convert json -o " + testrunJson + ` "${testRun}"`;
      await exec.exec(plutilExportCommand, null, null);

      let jsonString = fs.readFileSync(testrunJson, "utf8");
      const testTargets = JSON.parse(jsonString);

      for (const target of Object.keys(testTargets)) {
        if (target.charAt(0) !== "_") {
          if (testTargets[target].TestingEnvironmentVariables) {
            await insertEnvVariables(testRun, target);
          } else if (target === "TestConfigurations") {
            let configurationNumber = 0;
            for (const configuration of testTargets["TestConfigurations"]) {
              let testNumber = 0;
              for (const test of configuration["TestTargets"]) {
                await insertEnvVariables(
                  testRun,
                  target +
                    "." +
                    configurationNumber +
                    "." +
                    "TestTargets" +
                    "." +
                    testNumber,
                  dsn
                );
              }
            }
          }
        }
      }
      //run tests
      let testCommand =
        "xcodebuild test-without-building " +
        codeCoverParam +
        " -xctestrun " +
        `"${testRun}"` +
        ' -destination "' +
        destination +
        '"' +
        extraParameters;
      try {
        await exec.exec(testCommand, null, null);
      } catch (error) {
        testError = error.message;
      }
    }

    if (codePathEnabled) {
      //build command settings
      let buildCommandSettings =
        "xcodebuild -showBuildSettings -json -configuration " +
        configuration +
        " build-for-testing -xcconfig " +
        configFilePath +
        " " +
        projectParameter +
        " -scheme " +
        `"${scheme}"` +
        " -sdk " +
        sdk +
        " -derivedDataPath " +
        derivedDataPath +
        " -destination " +
        `"${destination}" ` +
        extraParameters;
      let auxOutput = "";
      const options = {};
      options.listeners = {
        stdout: data => {
          auxOutput += data.toString();
        }
      };
      await exec.exec(buildCommandSettings, null, options);
      const settingsArray = JSON.parse(auxOutput);
      for (const settings of settingsArray) {
        if (
          settings.buildSettings["PACKAGE_TYPE"] !==
          "com.apple.package-type.bundle.unit-test"
        ) {
          await runScopeCoverageWithSettings(
            settings.buildSettings,
            false,
            scopeFrameworkToolsPath
          );
        }
      }
    }

    if (!dsn) {
      core.warning(
        "SCOPE_DSN not found in secrets, results wont be uploaded to Scope app"
      );
    }

    if (testError) {
      core.setFailed(testError.message);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
  //Clean up
  fs.rmdirSync(scopeDir, { recursive: true });
}

async function swiftPackageRun(extraParameters, codePathEnabled, agentVersion) {
  //download scope
  await downloadLatestScope(agentVersion);
  let codeCoverParam = "";
  if (codePathEnabled) {
    codeCoverParam = " --enable-code-coverage ";
  }

  const scopeMacFrameworkPath = scopeDir + scope_macos_path;
  const scopeMacFrameworkToolsPath =
    scope_macos_path + "/ScopeAgent.framework/Resources/";

  //build and test

  let buildTestCommand =
    "swift test " +
    codeCoverParam +
    " -Xswiftc " +
    "-F" +
    scopeMacFrameworkPath +
    " " +
    " -Xswiftc -framework -Xswiftc ScopeAgent -Xlinker -rpath -Xlinker " +
    scopeMacFrameworkPath +
    " " +
    extraParameters;

  let testError;
  try {
    await exec.exec(buildTestCommand, null, {
      env: {
        ...envVars,
        SCOPE_COMMIT_SHA: envVars["GITHUB_SHA"],
        SCOPE_SOURCE_ROOT: envVars["GITHUB_WORKSPACE"]
      }
    });
  } catch (error) {
    testError = error.message;
  }

  if (testError) {
    core.setFailed(testError.message);
  }
  // Upload symbols
  let runScriptCommand =
    "sh -c " + scopeDir + scopeMacFrameworkToolsPath + "upload_symbols";
  exec.exec(runScriptCommand, null, {
    env: {
      ...envVars,
      TARGET_BUILD_DIR:
        process.env["GITHUB_WORKSPACE"] + "/.build/x86_64-apple-macosx/debug",
      CONFIGURATION_BUILD_DIR:
        process.env["GITHUB_WORKSPACE"] + "/.build/x86_64-apple-macosx/debug"
    },
    ignoreReturnCode: true
  });

  if (codePathEnabled) {
    await runScopeCoverageWithSettings(null, true, scopeMacFrameworkToolsPath);
  }
}

function getPathForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return scope_macos_path;
    case "tvos":
      return scope_tvos_path;
    default:
      return scope_ios_path;
  }
}

function getToolsPathForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return scope_macos_path + "/ScopeAgent.framework/Resources/";
    case "tvos":
      return scope_tvos_path + "/ScopeAgent.framework/";
    default:
      return scope_ios_path + "/ScopeAgent.framework/";
  }
}

function getSDKForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return "macosx";
    case "tvos":
      return "appletvsimulator";
    default:
      return "iphonesimulator";
  }
}

function getDestinationForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return "platform=macOS,arch=x86_64";
    case "tvos":
      return "platform=tvOS Simulator,name=Apple TV 4K";
    default:
      return "platform=iOS Simulator,name=iPhone 11";
  }
}

async function getWorkspace() {
  let workspace = core.getInput("workspace");
  if (!workspace) {
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
        workspace = myOutput.split("\n").find(function(file) {
          return file.match(/\.xcworkspace$/);
        });
      }
    };
    await exec.exec("ls", null, options);
  }
  return workspace;
}

async function getXCodeProj() {
  let xcodeproj = core.getInput("xcodeproj");
  if (!xcodeproj) {
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
        xcodeproj = myOutput.split("\n").find(function(file) {
          return file.match(/\.xcodeproj/);
        });
      }
    };
    await exec.exec("ls", null, options);
  }
  return xcodeproj;
}

async function generateProjectFromSPM() {
  let generateProjectCommand = "swift package generate-xcodeproj";
  const result = await exec.exec(generateProjectCommand, null, null);
  console.log(`SPM package`);
  xcodeproj = await getXCodeProj();
  return xcodeproj;
}

async function getScheme(workspace, xcodeproj) {
  let scheme = core.getInput("scheme");
  if (!scheme) {
    let command;
    if (workspace) {
      command = "xcodebuild -workspace " + workspace + " -list -json";
    } else {
      command = "xcodebuild -project " + xcodeproj + " -list -json";
    }
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
      }
    };
    try {
      await exec.exec(command, null, options);
    } catch (error) {
      core.setFailed(
        "Unable to automatically select a Scheme. Please set with .scheme parameter"
      );
      throw error;
    }
    const info = JSON.parse(myOutput);
    const aux = info.workspace || info.project;
    const schemes = aux.schemes;
    console.log("Available schemes: " + JSON.stringify(schemes));
    scheme = intelligentSelectScheme(schemes, aux);
  }
  return scheme;
}

function intelligentSelectScheme(schemes, workspacePath) {
  if (schemes.length < 1) {
    return null;
  }
  const workspaceName = workspacePath.name;
  if (schemes.includes(workspaceName)) {
    return workspaceName;
  }
  var el = schemes.find(a => a.includes(workspaceName));

  return el || schemes[0];
}

function createXCConfigFile(path, scopeFrameworkPath) {
  let configText =
    `
 // Configuration settings file format documentation can be found at:
 // https://help.apple.com/xcode/#/dev745c5c974
 
 DEBUG_INFORMATION_FORMAT = dwarf-with-dsym
` +
    "FRAMEWORK_SEARCH_PATHS = $(inherited) " +
    scopeDir +
    scopeFrameworkPath +
    "\n" +
    "OTHER_LDFLAGS =  $(inherited) -ObjC -framework ScopeAgent\n" +
    "LD_RUNPATH_SEARCH_PATHS = $(inherited) " +
    scopeDir +
    scopeFrameworkPath +
    "\n";

  fs.writeFileSync(path, configText, null);
}

async function downloadLatestScope(agentVersion) {
  const versionsUrl =
    "https://releases.undefinedlabs.com/scope/agents/ios/ScopeAgent.json";
  const jsonResponse = await fetch(versionsUrl);
  const versions = await jsonResponse.json();
  let currentVersion = "0.0.1";
  Object.keys(versions).forEach(function(name) {
    if (semver.gt(name, currentVersion) && !semver.prerelease(name)) {
      currentVersion = name;
    }
  });
  const scopeURL = versions[agentVersion] || versions[currentVersion];
  const scopePath = scopeDir + "/scopeAgent.zip";
  console.log(`Scope agent downloading: ${scopeURL}`);
  await downloadFile(scopeURL, scopePath);

  const extractCommand =
    "ditto -x -k " + scopePath + " " + scopeDir + "/scopeAgent";
  await exec.exec(extractCommand, null, null);
}

const downloadFile = async (url, path) => {
  const res = await fetch(url);
  const fileStream = fs.createWriteStream(path);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", err => {
      reject(err);
    });
    fileStream.on("finish", function() {
      resolve();
    });
  });
};

function uploadSymbols(projectParameter, dsn, scopeFrameworkToolsPath) {
  let runScriptCommand =
    "sh -c " + scopeDir + scopeFrameworkToolsPath + "upload_symbols";
  exec.exec(runScriptCommand, null, {
    env: {
      ...envVars,
      TARGET_BUILD_DIR: xctestDir,
      CONFIGURATION_BUILD_DIR: xctestDir
    },
    ignoreReturnCode: true
  });
}

async function getXCTestRuns() {
  let myOutput = "";
  let testRuns = [""];
  const options = {};
  options.listeners = {
    stdout: data => {
      myOutput += data.toString();
      testRuns = myOutput.split("\n").filter(function(file) {
        return file.match(/\.xctestrun$/);
      });
    }
  };
  await exec.exec("ls " + xctestDir, null, options);
  testRuns.forEach(function(part, index, theArray) {
    theArray[index] = xctestDir + part;
  });
  return testRuns;
}

async function runScopeCoverageWithSettings(
  buildSettings,
  isSPM,
  scopeFrameworkToolsPath
) {
  let runScriptCommand =
    "sh -c " + scopeDir + scopeFrameworkToolsPath + "scope-coverage";
  await exec.exec(runScriptCommand, null, {
    env: {
      ...buildSettings,
      SCOPE_DSN: envVars[SCOPE_DSN],
      TMPDIR: isSPM
        ? process.env["GITHUB_WORKSPACE"] + "/.build/x86_64-apple-macosx/debug"
        : os.tmpdir() + "/",
      PRODUCT_BUNDLE_IDENTIFIER: isSPM
        ? ""
        : buildSettings.PRODUCT_BUNDLE_IDENTIFIER
    },
    ignoreReturnCode: true
  });
}

async function insertEnvVariables(file, target) {
  await insertEnvVariable(SCOPE_DSN, envVars[SCOPE_DSN], file, target);
  await insertEnvVariable(
    "SCOPE_COMMIT_SHA",
    envVars["GITHUB_SHA"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "SCOPE_SOURCE_ROOT",
    envVars["GITHUB_WORKSPACE"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "GITHUB_REPOSITORY",
    envVars["GITHUB_REPOSITORY"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "GITHUB_RUN_ID",
    envVars["GITHUB_RUN_ID"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "GITHUB_RUN_NUMBER",
    envVars["GITHUB_RUN_NUMBER"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "SCOPE_SET_GLOBAL_TRACER",
    envVars["SCOPE_SET_GLOBAL_TRACER"] || "",
    file,
    target
  );
  await insertEnvVariable(
    "SCOPE_INSTRUMENTATION_HTTP_PAYLOADS",
    envVars["SCOPE_INSTRUMENTATION_HTTP_PAYLOADS"] || "",
    file,
    target
  );

  await insertEnvVariable(
    "SCOPE_INSTRUMENTATION_HTTP_CLIENT",
    envVars["SCOPE_INSTRUMENTATION_HTTP_CLIENT"] || "",
    file,
    target
  );
}

async function insertEnvVariable(name, value, file, target) {
  if (value !== "") {
    let insertCommand =
      'plutil -replace "' +
      target +
      ".EnvironmentVariables." +
      name +
      '" -string ' +
      value +
      ` "${file}"`;
    await exec.exec(insertCommand, null, null);
  }
}

function recFindByExt(base, ext, files, result) {
  files = files || fs.readdirSync(base);
  result = result || [];

  files.forEach(function(file) {
    var newbase = path.join(base, file);
    if (fs.statSync(newbase).isDirectory()) {
      result = recFindByExt(newbase, ext, fs.readdirSync(newbase), result);
    } else {
      if (file.substr(-1 * (ext.length + 1)) === "." + ext) {
        result.push(newbase);
      }
    }
  });
  return result;
}

async function deleteLinesContaining(file, match) {
  let newName = file + "_old";
  await io.mv(file, newName);
  fs.readFile(newName, { encoding: "utf-8" }, function(err, data) {
    if (err) throw error;

    let dataArray = data.split("\n"); // convert file data in an array
    const searchKeyword = match; // we are looking for a line, contains, key word 'user1' in the file
    let lastIndex = -1; // let say, we have not found the keyword

    for (let index = 0; index < dataArray.length; index++) {
      if (dataArray[index].includes(searchKeyword)) {
        // check if a line contains the 'user1' keyword
        lastIndex = index; // found a line includes a 'user1' keyword
        break;
      }
    }

    dataArray.splice(lastIndex, 1); // remove the keyword 'user1' from the data Array

    // UPDATE FILE WITH NEW DATA
    // IN CASE YOU WANT TO UPDATE THE CONTENT IN YOUR FILE
    // THIS WILL REMOVE THE LINE CONTAINS 'user1' IN YOUR shuffle.txt FILE
    const updatedData = dataArray.join("\n");
    fs.writeFile(file, updatedData, err => {
      if (err) throw err;
      console.log("Successfully updated the file data");
    });
  });
}

run();
