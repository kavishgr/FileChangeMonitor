var Domain = require('./models/Domain');
var File = require('./models/File');
var User = require('./User/user.model');
let paranoid = require('paranoid-request');
var auth = require('./auth/auth.service');
var fs = require('fs');
var helperMethods = require('./helperMethods');
var Promise = require('bluebird');
var CronJob = require('cron').CronJob;

//testing cronjob to create a testing file
new CronJob('0 * * * * *', function() {
  var string = `//super cool js file to query from a server
var urls = [];
urls.push('/some_endpoint')`;
  for (var i = 0; i<3; i++) {
    var urls = ['admin', 'createUser', 'getUser', 'postUser', 'listThings', 'getThing', 'superVulnerableEndpoint', 'somethingShouldBeHere', 'obsureEndpointThatYouHaveNoIdeaWhatItDoes', 'createSomethingNew', 'rceShell'];
    var url = urls[Math.floor(Math.random()*urls.length)];
    string += `\r\nurls.push('/${url}')`
  }
  fs.writeFile('public/testingFile.js', string, function(err) {
    if(err) {
        return console.log(err);
    }
    console.log("The file was saved!");
  });
}, null, true, 'America/Chicago');

// Poll periodically to check for changes in files
// runs every minute
new CronJob('0 * * * * *', function() {
  // First, we need to decide which files to poll for updates.
  var time = Math.floor(new Date().getTime() / 1000);
  console.log('STARTING CRON');
  File.find()
  .select('+pollOffset')
  .exec((err, response) => {
    response.forEach(function(file, index) {
      var numMinutes = Math.floor(time / 60);
      var pollMinutes = Math.floor(file.pollTime / 60);
      var offsetMinutes = Math.floor(file.pollOffset / 60);
      // TODO: Replace calculation with database-level query using $mod
      if (numMinutes % pollMinutes == offsetMinutes) {
        console.log('Checking file for changes: ' + file.url);
        if (file.dynamic) {
          // If dynamic, fetch the base domain and see if the file name has changed
          paranoid.get(file.baseDomain, (err, res, data) => {
            if (err || !data) return;
            console.log(file)
            var pageUrls = helperMethods.extractUrls(file.baseDomain, data, 'script', 'src=', '.js');
            var foundUrl = '';
            for (url of pageUrls) {
              // Compute the name of the file, i.e. the part after the last slash
              var fileName = file.baseUrl.split('/').pop();
              if (url.includes(fileName)) {
                foundUrl = url;
                break;
              }
            }

            if(foundUrl != '' && foundUrl != file.url) {
              // url has been updated, proceed as usual
              file.url = helperMethods.normalizeUrl(file.baseDomain, foundUrl);
              file.save();
              console.log('Change detected in filename. New name: ' + file.url);
              reloadFileAndNotifyUser(file);
            }
          });
        } else {
          reloadFileAndNotifyUser(file);
        }
      }
    });
  });
}, null, true, 'America/Chicago');

function reloadFileAndNotifyUser(file) {
  file.reloadFile(false, (err) => {
    console.log(err);
  }, (fileResponse) => {
    console.log('Checking for changes: ' + file.url);
    if (!fileResponse.modified) return;
    if ((file.notifyThresholdUnit == 'characters' && fileResponse.numLinesModified >= file.notifyThreshold)
         || file.notifyThresholdUnit == 'urls' && fileResponse.numUrlLinesModified >= file.notifyThreshold) {
      User.findOne({ _id: file.user}, (userErr, user) => {
        if (userErr) {
          console.log(userErr);
          return;
        }
        helperMethods.sendUpdateEmail(user.email, fileResponse)
      });
    }
  });
}

module.exports = function(app) {

  // server routes ===========================================================
  // handle things like api calls
  // authentication routes

  app.use('/auth', require('./auth'));
  app.use('/user', require('./User'));

  app.get('/api/domains', auth.ensureAuthenticated, function(req, res) {
    Domain.find({ user: req.user }, (err, response) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        res.status(200).json(response);
      });
  });

  app.post('/api/domains/previewJSUrls', auth.ensureAuthenticated, function(req, res) {
    paranoid.get(req.body.url, (err, newRes, data) => {
      if (err) {
        console.log(err);
        return res.status(500).send();
      }
      urls = helperMethods.extractUrls(req.body.url, data, 'script', 'src=', '.js');
      res.status(200).json(urls);
    });
  });

  app.post('/api/domains', auth.ensureAuthenticated, function(req, res) {
    User.findById(req.user, function(err, user) {
      if (err || !user) {
        console.log(err);
        return res.status(500).send();
      }
      Domain.create({
        name: req.body.name,
        user: req.user
      }, (err, domain) => {
        if (err || !domain) {
          console.log(err);
          return res.status(500).send();
        }
        if (user.numFiles + req.body.urls.length > user.maximumFiles) {
          return res.status(500).json({ 'error': 'This would exceed your file limit.' });
        }
        var files = [];
        for (url of req.body.urls) {
          files.push(domain.addFile(url));
        }
        Promise.all(files).then(() => {
          user.updateFileCount();
          domain.save();
          res.status(200).json(domain);
        }).catch((err) => {
          console.log(err);
          return res.status(500).send();
        });
      });
    });
  });

  app.post('/api/domains/:id', auth.ensureAuthenticated, function(req, res) {
    Domain.findOne({ _id: req.params.id, user: req.user }, (err, domain) => {
      if (err) {
        console.log(err);
        return res.status(500).send();
      }
      domain.name = req.body.name;
      domain.save();
      res.status(200).json(domain);
    });
  });

  app.post('/api/domains/:id/addFiles', auth.ensureAuthenticated, function(req, res) {
    Domain.findOne({ _id: req.params.id, user: req.user })
      .populate('user')
      .exec((err, domain) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        if (domain.user.numFiles + req.body.urls.length > domain.user.maximumFiles) {
          return res.status(500).json({ 'message': 'This would exceed your file limit.' });
        }
        var files = [];
        for (url of req.body.urls) {
          files.push(domain.addFile({
            url: url
          }));
        }
        Promise.all(files).then(() => {
          domain.user.updateFileCount();
          domain.save();
          res.status(200).json(domain);
        }).catch((err) => {
          console.log(err);
          return res.status(500).send();
        });
      });
  });

  app.get('/api/domains/:id', auth.ensureAuthenticated, function(req, res) {
    Domain.findOne({ _id: req.params.id, user: req.user })
      .populate('files user')
      .exec((err, response) => {
        console.log(response.user)
        response.user.updateFileCount();
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        res.status(200).json(response);
      });
  });

  app.post('/api/files/:id', auth.ensureAuthenticated, function(req, res) {
    File.findOne({ _id: req.params.id, user: req.user }, (err, file) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        file.url = req.body.url;
        file.pollTime = req.body.pollTime || 3600*24;
        file.notifyThreshold = req.body.notifyThreshold || 0;
        file.notifyThresholdUnit = req.body.notifyThresholdUnit || 'urls';
        file.save((err) => {
          if (err) {
            console.log(err)
          }
        });
        res.status(200).json(file);
      });
  });

  app.get('/api/files/:id', auth.ensureAuthenticated, function(req, res) {
    File.findOne({ _id: req.params.id, user: req.user }, (err, response) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        res.status(200).json(response);
      });
  });

  app.get('/api/files/:id/fileContents', auth.ensureAuthenticated, function(req, res) {
    File.findOne({ _id: req.params.id, user: req.user }, (err, file) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        file.getRemoteContents((err) => {
          console.log(err);
          return res.status(500).send();
        }, (data) => {
            res.status(200).json({ 'data': data });
        }, req.query.all);
      });
  });

  app.post('/api/files/:id/reloadFile', auth.ensureAuthenticated, function(req, res) {
    // Disable this function in prod
    if (process.env.NODE_ENV != 'development') {
      return res.status(500).send();
    }
    File.findOne({ _id: req.params.id, user: req.user }, (err, file) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        file.reloadFile(false, (err) => {
          console.log(err);
          return res.status(500).send();
        }, (data) => {
          res.status(200).json({ 'data': data });
        })
      });
  });

  app.delete('/api/domains/:id', auth.ensureAuthenticated, function(req, res) {
    Domain.findOne({ _id: req.params.id, user: req.user }, (err, domain) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        domain.remove((err, response) => {
          if (err) {
            console.log(err);
            return res.status(500).send();
          }
          res.status(204).end();
        });
      });
  });

  app.delete('/api/files/:id', auth.ensureAuthenticated, function(req, res) {
    File.findOne({ _id: req.params.id, user: req.user }, (err, file) => {
        if (err) {
          console.log(err);
          return res.status(500).send();
        }
        file.remove((err, response) => {
          if (err) {
            console.log(err);
            return res.status(500).send();
          }
          res.status(204).end();
        });
      });
  });

  // frontend routes =========================================================
  // route to handle all angular requests
  app.get('*', function(req, res) {
    res.sendfile('./public/index.html');
  });

};