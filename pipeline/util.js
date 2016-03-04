'use strict'

var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');
var chalk       = require('chalk');
var Promise     = require('promise');

function Util() {};
module.exports = Util;


var s3, cloudFormation;

Util.init = function(region) {
    AWS.config.region  = region
    s3             = new AWS.S3();
    cloudFormation = new AWS.CloudFormation();
};

Util.getStack = function(stackName) {
    return new Promise(function(resolve,reject) {
        cloudFormation.describeStacks({StackName: stackName}, function(err, data) {
            if (err || data.Stacks == null) {
                resolve(null);
            } else {
                resolve(data.Stacks.find(function(s) { return s.StackName === stackName || s.StackId === stackName; }));
            }
        });
    });
};


Util.getSubStackOutput = function(stackName,subStackName,outputKey) {
    return Util.getStackResource(stackName,subStackName)
        .then(function(subStackResource) {
            return Util.getStackOutput(subStackResource.PhysicalResourceId, outputKey);
        });
};

Util.getStackOutput = function(stackName, outputKey) {
    return Util.getStack(stackName)
        .then(function(stack) {
            if(stack) {
                try {
                    return stack.Outputs.find(function (o) { return o.OutputKey === outputKey }).OutputValue;
                } catch (e) {
                    return null;
                }
            }
        });
};

Util.getStackResource = function(stackName, resourceName) {
    return new Promise(function(resolve) {
        cloudFormation.describeStackResources({StackName: stackName, LogicalResourceId: resourceName}, function(err, data) {
            if (err || data.StackResources == null) {
                resolve(null);
            } else {
                resolve(data.StackResources.find(function (r) { return r.LogicalResourceId === resourceName }));
            }
        });
    });
};

Util.emptyBucket = function(bucketName) {
    return new Promise(function(resolve,reject){
        s3.listObjects({Bucket: bucketName}, function(err, data) {
            if (err) {
                resolve(true);
            } else {

                var objects = data.Contents.map(function (c) { return { Key: c.Key }});
                var params = {
                    Bucket: bucketName,
                    Delete: {
                        Objects: objects
                    }
                };

                if(objects.length > 0) {
                    s3.deleteObjects(params, function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(true);
                        }
                    });
                } else {
                    resolve(true);
                }
            }
        });

    });
};


Util.uploadToS3 = function(dir,bucketName) {
    return new Promise(function(resolve,reject) {
        var files = fs.readdirSync(dir);
        var respCount = 0;
        files.forEach(function(file) {
            var path = dir + '/' + file;
            if (!fs.statSync(path).isDirectory()) {
                console.log("Uploading: "+ path);
                var params = {
                    Bucket: bucketName,
                    Key: file,
                    ACL: 'public-read',
                    ContentType: mime.lookup(path),
                    Body: fs.readFileSync(path)
                }

                s3.putObject(params, function(err, data) {
                    if (err) {
                        console.log(err, err.stack);
                    }

                    if(++respCount >= files.length) {
                        resolve(true);
                    }
                });
            } else {
                respCount++;
            }
        });

        if(files.length==0) {
            resolve(true);
        }

    });
};


