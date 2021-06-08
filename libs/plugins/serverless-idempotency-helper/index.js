"use strict";
const _ = require("lodash");
const extract = require("extract-zip");
const fs = require("fs");
const glob = require("glob");
const path = require("path");
var zip = require("bestzip");

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      "package:createDeploymentArtifacts": this.repackAllFunctions.bind(this),
      "package:compileEvents": this.repackAnyOtherZips.bind(this),
      // "before:deploy:deploy": this.helpProviderApiLoggingBeIdempotent.bind(
      //   this
      // ),
    };
  }

  async repackAllFunctions() {
    const serviceDir = this.serverless.serviceDir;
    const dotServerlessDir = `${serviceDir}/.serverless`;

    // Repack all functions that are set to deploy
    const functionArchives = getFunctionArchives.call(this);
    await repackFunctions.call(this, functionArchives);
  }

  async repackAnyOtherZips() {
    // Sometimes additional functions are added, outside of the serverless.yml
    // This function is meant to trigger later in the package lifecycle, and it it meant to repack
    // any additional functions (ex: the custom-resources function generated by api logging)
    // Some of these zips aren't created until this later lifecycle stage
    const serviceDir = this.serverless.serviceDir;
    const dotServerlessDir = `${serviceDir}/.serverless`;
    const functionArchives = getFunctionArchives.call(this);
    let zips = glob.sync(`${dotServerlessDir}/**/*.zip`, {
      dot: true,
      silent: true,
      follow: true,
    });
    zips = zips.filter((el) => !functionArchives.includes(el));

    await repackFunctions.call(this, zips);
  }
}

module.exports = ServerlessPlugin;

function isIndividialPackaging() {
  return _.get(this.serverless, "service.package.individually");
}

function getFunctionArchives() {
  const serviceDir = this.serverless.serviceDir;
  const dotServerlessDir = `${serviceDir}/.serverless`;
  var archives = [];
  const functionNames = this.options.function
    ? [this.options.function]
    : this.serverless.service.getAllFunctions();
  if (isIndividialPackaging.call(this)) {
    functionNames.forEach((name) => {
      archives.push(`${dotServerlessDir}/${name}.zip`);
    });
    return archives;
  } else {
    archives.push(
      `${dotServerlessDir}/${
        this.serverless.service.getServiceObject().name
      }.zip`
    );
  }
  return archives;
}

async function repackFunctions(archives) {
  this.serverless.cli.log("Repacking functions for speed...");

  // Tell the zip command to forego creating directory entries in the archive, via the ZIPOPT variable.
  // See:  https://linux.die.net/man/1/zip
  process.env.ZIPOPT = "-D";

  // Arbitrary, fixed time, used later when setting atime and mtime on files.
  const time = new Date(1990, 1, 1);

  // Define several directories for convenience.
  const serviceDir = this.serverless.serviceDir;
  const dotServerlessDir = `${serviceDir}/.serverless`;
  const repackDir = `${serviceDir}/.repack`;

  // Discover all zip files that need to be repacked
  // Typically, function names can be found in the serverless object,
  // however, sometimes archives are placed here outside the scope of the
  // serverless.yml, such as with custom-resources generated by other plugins.
  let zips = archives;

  // Make sure the temp dir for repacking is recreated cleanly.
  fs.rmdir(repackDir, { recursive: true }, (err) => {});
  this.serverless.utils.writeFileDir(repackDir);

  // Iterate over each zip.  Using a for loop since we need to await inside of it.
  for (let index = 0; index < zips.length; index++) {
    // Basename of the archive, without extension.
    var funcName = path.basename(zips[index], ".zip");

    // Temporary directory where the archive will be unpacked.
    var extractDir = `${repackDir}/${funcName}`;

    // Unzip the archive
    await extract(zips[index], { dir: extractDir });

    // Find all files in the archive, and reset last accessed and modified timestamps.
    // These timestamps affect the archive's commit hash, and setting them to a fixed
    // value is key to achieving idempotency.
    let files = glob.sync(`${extractDir}/**/*`, {
      dot: true,
      silent: true,
      follow: true,
    });
    files.forEach((file) => {
      fs.utimesSync(file, time, time);
    });

    // Repack the zip file.
    // Note:  The env variable ZIPOPT, set near the top of this file, will take affect
    // and will not include direcory entries in the zip.
    var zipArgs = {
      source: `.`,
      cwd: extractDir,
      destination: `../${funcName}.zip.new`,
    };
    await zip(zipArgs).catch(function (err) {
      console.error(err.stack);
      process.exit(1);
    });

    // Copy the repacked zip file to the .serverless directory.
    fs.copyFileSync(`${repackDir}/${funcName}.zip.new`, zips[index]);
  }

  // Remove the .repack directory
  fs.rmdir(repackDir, { recursive: true }, (err) => {});
}
