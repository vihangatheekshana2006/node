/*
 *           __                          __      __
 *     _____/ /____  ______  ____  _____/ /_____/ /
 *    / ___/ //_/ / / / __ \/ __ \/ ___/ __/ __  / 
 *   (__  ) ,< / /_/ / /_/ / /_/ / /  / /_/ /_/ /  
 *  /____/_/|_|\__, / .___/\____/_/   \__/\__,_/   
 *            /____/_/                        
 * 
 *  Skyport Daemon v0.3.0 (Desiro City)
 *  (c) 2024 Matt James and contributers
 * 
*/

/**
 * @fileoverview Main entry file for the Skyport Daemon. This module sets up an
 * Express server integrated with Docker for container management and WebSocket for real-time communication.
 * It includes routes for instance management, deployment, and power control, as well as WebSocket endpoints
 * for real-time container stats and logs. Authentication is enforced using basic authentication.
 * 
 * The server initializes with logging and configuration, sets up middleware for body parsing and authentication,
 * and dynamically handles WebSocket connections for various operational commands and telemetry.
 */
process.env.dockerSocket = process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
const express = require('express');
const Docker = require('dockerode');
const basicAuth = require('express-basic-auth');
const bodyParser = require('body-parser');
const CatLoggr = require('cat-loggr');
const WebSocket = require('ws');
const http = require('http');
const fs = require('node:fs');
const path = require('path');
const chalk = require('chalk')
const fs2 = require('fs').promises;
const ascii = fs.readFileSync('./handlers/ascii.txt', 'utf8');
const { exec } = require('child_process');
const { start, createNewVolume } = require('./handlers/ftp.js')
const { createDatabaseAndUser } = require('./handlers/database.js');
const config = require('./config.json');
const statsLogger = require('./handlers/stats.js');

const docker = new Docker({ socketPath: process.env.dockerSocket });

/**
 * Initializes a WebSocket server tied to the HTTP server. This WebSocket server handles real-time
 * interactions such as authentication, container statistics reporting, logs streaming, and container
 * control commands (start, stop, restart). The WebSocket server checks for authentication on connection
 * and message reception, parsing messages as JSON and handling them according to their specified event type.
 */
const app = express();
const server = http.createServer(app);

const log = new CatLoggr();

/**
 * Sets up Express application middleware for JSON body parsing and basic authentication using predefined
 * user keys from the configuration. Initializes routes for managing Docker instances, deployments, and
 * power controls. These routes are grouped under the '/instances' path.
 */
console.log(chalk.gray(ascii) + chalk.white(`version v${config.version}\n`));
async function init() {
    try {
        docker.ping((err) => {
            if (err) {
                log.error(chalk.red('Docker is not running or not installed. Please install Docker and try again.'))
                process.exit()
            }
        })

        const volumesPath = path.join(__dirname, './volumes');
        await fs2.mkdir(volumesPath, { recursive: true });

        log.info('volumes folder created successfully');

        // Node Stats
        statsLogger.initLogger();

        // Dockerode Fix for Windows
        if (process.platform === 'win32') {
            const lockFilePath = path.join(__dirname, 'node_modules', 'docker-modem', 'lib', 'docker_modem_fix.lock');
            const modemPath = path.join(__dirname, 'node_modules', 'docker-modem', 'lib', 'modem.js');
            const modemUrl = 'https://raw.githubusercontent.com/achul123/docker-modem/refs/heads/master/lib/modem.js';
        
            if (!fs.existsSync(lockFilePath)) {
                log.info('Fixing docker-modem for windows...');
                // download the file and save in /node_modules/docker-modem/lib/modem.js
                const response = await fetch(modemUrl);
                const data = await response.text();
                await fs2.writeFile(modemPath, data);
            
                // Create the lock file to prevent future executions
                await fs2.writeFile(lockFilePath, 'Docker-modem fix applied');
                log.info('Docker-modem fix applied');
            }
        }

    } catch (error) {
        log.error('failed to retrieve image list from remote! the panel might be down. error:', error.message);
        process.exit();
    }
}
init()

app.use(bodyParser.json());
app.use(basicAuth({
    users: { 'Skyport': config.key },
    challenge: true
}));

async function startLoggingStats() {
    setInterval(async () => {
        try {
            const stats = await statsLogger.getSystemStats();
            statsLogger.saveStats(stats);
        } catch (error) {
            console.error('Error logging stats:', error);
        }
    }, 10000);
}

startLoggingStats();

app.get('/stats', async (req, res) => {
    try {
        const totalStats = statsLogger.getSystemStats.total();
        const containers = await docker.listContainers({ all: true });
        const onlineContainersCount = containers.filter(container => container.State === 'running').length;
        const uptimeInSeconds = process.uptime();

        const formatUptime = (uptime) => {
            const minutes = Math.floor((uptime / 60) % 60);
            const hours = Math.floor((uptime / 3600) % 24);
            const days = Math.floor(uptime / 86400);
            const parts = [];

            if (days > 0) parts.push(`${days}d`);
            if (hours > 0) parts.push(`${hours}h`);
            if (minutes > 0) parts.push(`${minutes}m`);
            if (parts.length === 0) return '0m';

            return parts.join(' ');
        };

        const responseStats = {
            totalStats,
            onlineContainersCount,
            uptime: formatUptime(uptimeInSeconds)
        };

        res.json(responseStats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// FTP
start();
// FTP Route
app.get('/ftp/info/:id', (req, res) => {
    const filePath = './ftp/user-' + req.params.id + '.json';
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            log.error('Error reading file:', err);
            res.status(500).json({ error: 'Error reading file' });
            return;
        }
        res.json(JSON.parse(data));
    });
});

// Database Route
app.post('/database/create/:name', async (req, res) => {
    try {
        const dbName = req.params.name;
        const credentials = await createDatabaseAndUser(dbName);
        res.status(200).json({
            message: `Database ${dbName} created successfully`,
            credentials
        });
    } catch (error) {
        console.error('Error creating database:', error);
        res.status(500).json({ error: 'Failed to create database' });
    }
});

// Function to dynamically load routers
function loadRouters() {
    const routesDir = path.join(__dirname, 'routes');
    fs.readdir(routesDir, (err, files) => {
        if (err) {
            log.error(`Error reading routes directory: ${err.message}`);
            return;
        }

        files.forEach((file) => {
            if (file.endsWith('.js')) {
                try {
                    const routerPath = path.join(routesDir, file);
                    const router = require(routerPath);
                    if (typeof router === 'function' && router.name === 'router') {
                        const routeName = path.parse(file).name;
                        app.use(`/`, router);
                        log.info(`Loaded router: ${routeName}`);
                    } else {
                        log.warn(`File ${file} isn't a router. Not loading it`);
                    }
                } catch (error) {
                    log.error(`Error loading router from ${file}: ${error.message}`);
                }
            }
        });
    });
}

// Call the function to load routers
loadRouters();

/**
 * Initializes a WebSocket server tied to the HTTP server. This WebSocket server handles real-time
 * interactions such as authentication, container statistics reporting, logs streaming, and container
 * control commands (start, stop, restart). The WebSocket server checks for authentication on connection
 * and message reception, parsing messages as JSON and handling them according to their specified event type.
 * 
 * @param {http.Server} server - The HTTP server to bind the WebSocket server to.
 */
function initializeWebSocketServer(server) {
    const wss = new WebSocket.Server({ server }); // use express-ws so you can have multiple ws's, api routes & that on 1 server.
    const containerLogs = {}; // Store logs for each container in memory

    wss.on('connection', (ws, req) => {
        let isAuthenticated = false;

        ws.on('message', async (message) => {
            log.debug('got ' + message);
            let msg = {};
            try {
                msg = JSON.parse(message);
            } catch (error) {
                ws.send('Invalid JSON');
                return;
            }

            if (msg.event === 'auth' && msg.args) {
                authenticateWebSocket(ws, req, msg.args[0], (authenticated, containerId, volumeId) => {
                    if (authenticated) {
                        isAuthenticated = true;
                        handleWebSocketConnection(ws, req, containerId, volumeId);
                    } else {
                        ws.send('Authentication failed');
                        ws.close(1008, "Authentication failed");
                    }
                });
            } else if (isAuthenticated) {
                const urlParts = req.url.split('/');
                const containerId = urlParts[2];

                if (!containerId) {
                    ws.close(1008, "Container ID not specified");
                    return;
                }

                const container = docker.getContainer(containerId);

                switch (msg.event) {
                    case 'cmd':
                        executeCommand(ws, container, msg.command);
                        break;
                    case 'power:start':
                        performPowerAction(ws, container, 'start');
                        break;
                    case 'power:stop':
                        performPowerAction(ws, container, 'stop');
                        break;
                    case 'power:restart':
                        performPowerAction(ws, container, 'restart');
                        break;
                    default:
                        ws.send('Unsupported event');
                        break;
                }
            } else {
                ws.send('Unauthorized access');
                ws.close(1008, "Unauthorized access");
            }
        });

        function authenticateWebSocket(ws, req, password, callback) {
            if (password === config.key) {
                log.info('successful authentication on ws');
                ws.send(`\r\n\u001b[33m[skyportd] \x1b[0mconnected!\r\n`);
                const urlParts = req.url.split('/');
                const containerId = urlParts[2];
                const volumeId = urlParts[3] || 0;

                if (!containerId) {
                    ws.close(1008, "Container ID not specified");
                    callback(false, null);
                    return;
                }

                callback(true, containerId, volumeId);
            } else {
                log.warn('authentication failure on websocket!');
                callback(false, null);
            }
        }


        /**
         * Handles an incoming WebSocket connection.
         *
         * @param {WebSocket} ws - The incoming WebSocket object
         * @param {Request} req - The request that triggered the WebSocket connection
         * @param {string} containerId - The ID of the container to connect to
         * @param {number} volumeId - The volume ID to connect to (or 0 for the default volume)
         */
        function handleWebSocketConnection(ws, req, containerId, volumeId) {
            const container = docker.getContainer(containerId);
            const volume = volumeId || 0;

            container.inspect(async (err, data) => {
                if (err) {
                    ws.send('Container not found');
                    return;
                }
        
                if (req.url.startsWith('/exec/')) {
                    setupExecSession(ws, container);
                } else if (req.url.startsWith('/stats/')) {
                    setupStatsStreaming(ws, container, volume);
                } else {
                    ws.close(1002, "URL must start with /exec/ or /stats/");
                }
            });
        }

        function initializeContainerLogs(containerId) {
            containerLogs[containerId] = [];
        }
        
        async function streamDockerLogs(ws, container) {
            const containerId = container.id;

            if (!containerLogs[containerId]) {
                initializeContainerLogs(containerId);
            }

            if (containerLogs[containerId].length > 0) {
                containerLogs[containerId].forEach(logMessage => {
                    ws.send(formatLogMessage(logMessage));
                });
            }

            const logStream = await container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                tail: 0 // Start streaming logs immediately 
            });
        
            logStream.on('data', chunk => {
                const logMessage = {
                    timestamp: new Date().toISOString(),
                    content: chunk.toString(),
                };

                containerLogs[containerId].push(logMessage);

                ws.send(formatLogMessage(logMessage));
            });
        
            ws.on('close', () => {
                logStream.destroy();
                log.info('WebSocket client disconnected');
            });
        }
        
        // Helper function to format log messages
        function formatLogMessage(logMessage) {
            return `\r\n\u001b[34m[docker] \x1b[0m${logMessage.content}\r\n`;
        }

        async function setupExecSession(ws, container) {
            streamDockerLogs(ws, container);
        }

        async function setupStatsStreaming(ws, container, volumeId) {
            const fetchStats = async () => {
                try {
                    const stats = await new Promise((resolve, reject) => {
                        container.stats({ stream: false }, (err, stats) => {
                            if (err) {
                                reject(new Error('Failed to fetch stats'));
                            } else {
                                resolve(stats);
                            }
                        });
                    });
        
                    // Calculate volume size
                    const volumeSize = await getVolumeSize(volumeId);
        
                    // Add volume size to stats object
                    stats.volumeSize = volumeSize;
        
                    ws.send(JSON.stringify(stats));
                } catch (error) {
                    ws.send(JSON.stringify({ error: error.message }));
                }
            };
        
            await fetchStats();
        
            const statsInterval = setInterval(fetchStats, 2000);
        
            ws.on('close', () => {
                clearInterval(statsInterval);
                log.info('WebSocket client disconnected');
            });
        }

        async function executeCommand(ws, container, command) {
            try {
                const stream = await container.attach({
                    stream: true,
                    stdin: true,
                    stdout: true,
                    stderr: false, // doesn't use stderr
                    hijack: true
                });
        
                // Collect output and send it back via WebSocket
                stream.on('data', (chunk) => {
                    //ws.send(chunk.toString('utf8'));
                });
        
                stream.on('end', () => {
                    log.info('Attach stream ended');
                    //ws.send('\nCommand execution completed');
                });
        
                stream.on('error', (err) => {
                    log.error('Attach stream error:', err);
                    ws.send(`Error in attach stream: ${err.message}`);
                });
        
                //log.info('Executing command:', command);
                stream.write(command + '\n');
        
                // Detach after sending the command to ensure proper execution
                stream.end();
        
            } catch (err) {
                log.error('Failed to attach to container:', err);
                ws.send(`Failed to attach to container: ${err.message}`);
            }
        }

        async function performPowerAction(ws, container, action) {
            const actionMap = {
                'start': container.start.bind(container),
                'stop': container.kill.bind(container),
                'restart': container.restart.bind(container),
            };
        
            if (!actionMap[action]) {
                ws.send(`\r\n\u001b[33m[skyportd] \x1b[0mInvalid action: ${action}\r\n`);
                return;
            }
        
            const containerId = container.id;
            const timestamp = new Date().toISOString();
            const message = {
                timestamp: timestamp,
                content: `\r\n\u001b[33m[skyportd] \x1b[0mWorking on ${action}...\r\n`,
            };
        
            ws.send(message.content); // Send the initial working message
        
            try {
                if (action === 'restart' || action === 'stop') {
                    containerLogs[containerId] = [];
                }

                // Start logging the container's logs
                streamDockerLogs(ws, container); // Start log streaming before the action
                
                await actionMap[action](); // Perform the requested action
        
                const successMessage = {
                    timestamp: new Date().toISOString(),
                    content: `\r\n\u001b[32m[skyportd] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`,
                };
                ws.send(successMessage.content);
        
            } catch (err) {
                log.error(`Error performing ${action} action:`, err.message);
                const errorMessage = {
                    timestamp: new Date().toISOString(),
                    content: `\r\n\u001b[31m[skyportd] \x1b[0mAction failed: ${err.message}\r\n`,
                };
                ws.send(errorMessage.content);
            }
        }

        async function getVolumeSize(volumeId) {
            const volumePath = path.join('./volumes', volumeId);
            try {
                const totalSize = await calculateDirectorySize(volumePath);
                return formatBytes(totalSize);
            } catch (err) {
                return 'Unknown';
            }
        }

        function calculateDirectorySize(directoryPath, currentDepth) {
            if (currentDepth >= 500) {
                log.warn(`Maximum depth reached at ${directoryPath}`);
                return 0;
            }
        
            let totalSize = 0;
            const files = fs.readdirSync(directoryPath);
            for (const file of files) {
                const filePath = path.join(directoryPath, file);
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) {
                    totalSize += calculateDirectorySize(filePath, currentDepth + 1);
                } else {
                    totalSize += stats.size;
                }
            }
            return totalSize;
        }

        // fixed in 0.2.2 sam
        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
    });
}

// Start the websocket server
initializeWebSocketServer(server);

/**
 * Default HTTP GET route that provides basic daemon status information including Docker connectivity
 * and system info. It performs a health check on Docker to ensure it's running and accessible, returning
 * the daemon's status and any pertinent Docker system information in the response.
 */
app.get('/', async (req, res) => {
    try {
        const dockerInfo = await docker.info();  // Fetches information about the docker
        const isDockerRunning = await docker.ping();  // Checks if the docker is up (which it probably is or this will err)

        // Prepare the response object with Docker status
        const response = {
            versionFamily: 1,
            versionRelease: 'skyportd ' + config.version,
            online: true,
            remote: config.remote,
            mysql: {
              host: config.mysql.host,
              user: config.mysql.user,
              password: config.mysql.password
            },
            docker: {
              status: isDockerRunning ? 'running' : 'not running',
              systemInfo: dockerInfo
            }
          };

        res.json(response); // the point of this? just use the ws - yeah conn to the ws on nodes page and send that json over ws
    } catch (error) {
        log.error('Error fetching Docker status:', error);
        res.status(500).json({ error: 'Docker is not running - skyportd will not function properly.' });
    }
});

app.use((err, req, res, next) => {
    log.error(err.stack);
    res.status(500).send('Something has... gone wrong!');
});

/**
 * Starts the HTTP server with WebSocket support after a short delay, listening on the configured port.
 * Logs a startup message indicating successful listening. This delayed start allows for any necessary
 * initializations to complete before accepting incoming connections.
 */
setTimeout(function (){
  server.listen(config.port, () => log.info(`skyportd is listening on port ${config.port}`));
}, 2000);