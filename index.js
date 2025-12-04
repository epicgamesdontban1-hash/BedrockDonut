// ============================================================================
// DOGGO - Minecraft Bedrock Discord Bot
// ============================================================================

const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { createClient } = require('bedrock-protocol');
const express = require('express');
const http = require('http');
const { StartupLogger } = require('./utils');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        channelId: process.env.DISCORD_CHANNEL_ID
    },
    minecraft: {
        host: 'donutsmp.net',
        port: 19132,
        username: '', // Your Xbox Gamertag
        auth: 'microsoft',
        offline: false,
        profilesFolder: './profiles'
    },
    webServer: {
        port: process.env.PORT || 5000,
        host: '0.0.0.0'
    }
};

// ============================================================================
// MAIN BOT CLASS
// ============================================================================

class MinecraftBedrockDiscordBot {
    constructor() {
        this.discordClient = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });
        this.minecraftBot = null;
        this.controlMessage = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.authUrl = null;
        this.userCode = null;
        this.shouldJoin = false;
        this.authMessageSent = false;
        this.authCheckTimeout = null;
        this.lastAuthUser = null;
        this.authInteraction = null;
        this.authCheckInterval = null;

        // Enhanced features
        this.currentWorld = 'Unknown';
        this.currentCoords = { x: 0, y: 0, z: 0 };
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectDelay = 15000;
        this.statusUpdateInterval = null;

        // Web server properties
        this.app = null;
        this.server = null;

        // Bedrock-specific properties
        this.currentHealth = 20;
        this.lastHealth = 20;
        this.nearbyPlayers = new Set();

        // Safety features
        this.safetyConfig = {
            enabled: false,
            proximityRadius: 50,
            minHealth: 10,
            alertCooldown: 30000,
            autoDisconnectOnThreat: true,
            autoDisconnectHealth: 6
        };
        this.lastHealthAlert = 0;
        this.lastProximityAlert = 0;
        
        // Whitelist/Blacklist system
        this.trustedPlayers = new Set(process.env.TRUSTED_PLAYERS?.split(',') || []);
        this.blockedPlayers = new Set(process.env.BLOCKED_PLAYERS?.split(',') || []);

        this.setupDiscordEvents();
        this.setupSlashCommands();
    }

    // ========================================================================
    // STARTUP & INITIALIZATION
    // ========================================================================

    async start() {
        const services = [];
        
        try {
            await this.discordClient.login(CONFIG.discord.token);
            services.push({ 
                name: 'Discord Bot', 
                status: true, 
                details: this.discordClient.user?.tag 
            });

            this.updateDiscordActivity('🔴 Offline', require('discord.js').ActivityType.Watching);

            this.statusUpdateInterval = setInterval(() => {
                if (this.isConnected && this.minecraftBot) {
                    this.updatePositionInfo();
                    this.updateEmbed();
                    this.updateDiscordActivity();
                }
            }, 30000);

        } catch (error) {
            services.push({ 
                name: 'Discord Bot', 
                status: false, 
                details: error.message 
            });
        }

        try {
            await this.startWebServer();
            services.push({ 
                name: 'Web Server', 
                status: true, 
                details: `http://${CONFIG.webServer.host}:${CONFIG.webServer.port}` 
            });
        } catch (error) {
            services.push({ 
                name: 'Web Server', 
                status: false, 
                details: error.message 
            });
        }

        services.push({ 
            name: 'Minecraft Bedrock Bot', 
            status: true, 
            details: 'Ready (awaiting connection)' 
        });

        StartupLogger.showStatus(services);

        const allOnline = services.every(s => s.status);
        if (!allOnline) {
            throw new Error('Some services failed to start');
        }
    }

    async startWebServer() {
        this.app = express();
        
        this.app.use(express.json());
        this.app.use(express.static('public'));
        this.setupWebRoutes();
        this.server = http.createServer(this.app);

        return new Promise((resolve, reject) => {
            this.server.listen(CONFIG.webServer.port, CONFIG.webServer.host, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    // ========================================================================
    // WEB SERVER ROUTES
    // ========================================================================

    setupWebRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                minecraft: {
                    connected: this.isConnected,
                    username: CONFIG.minecraft.username,
                    world: this.currentWorld,
                    coordinates: this.currentCoords
                },
                discord: {
                    connected: this.discordClient.readyTimestamp !== null,
                    username: this.discordClient.user?.tag || null
                }
            });
        });

        // Bot status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                minecraft: {
                    connected: this.isConnected,
                    shouldJoin: this.shouldJoin,
                    username: CONFIG.minecraft.username,
                    server: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`,
                    world: this.currentWorld,
                    coordinates: this.currentCoords,
                    reconnectAttempts: this.reconnectAttempts,
                    maxReconnectAttempts: this.maxReconnectAttempts,
                    authRequired: !!(this.authUrl && this.userCode)
                },
                discord: {
                    connected: this.discordClient.readyTimestamp !== null,
                    username: this.discordClient.user?.tag || null,
                    guildCount: this.discordClient.guilds.cache.size
                },
                uptime: process.uptime(),
                memory: process.memoryUsage()
            });
        });

        // Control endpoints
        this.app.post('/connect', async (req, res) => {
            if (this.isConnected) {
                return res.json({ success: false, message: 'Bot already connected' });
            }

            this.shouldJoin = true;
            this.reconnectAttempts = 0;
            await this.connectToMinecraft();
            
            res.json({ success: true, message: 'Connection initiated' });
        });

        this.app.post('/disconnect', async (req, res) => {
            this.shouldJoin = false;
            this.reconnectAttempts = 0;
            
            if (this.minecraftBot) {
                this.minecraftBot.disconnect();
                this.minecraftBot = null;
            }
            
            await this.updateEmbed();
            res.json({ success: true, message: 'Bot disconnected' });
        });

        // Send chat message endpoint
        this.app.post('/chat', (req, res) => {
            const { message } = req.body;
            
            if (!this.isConnected || !this.minecraftBot) {
                return res.json({ success: false, message: 'Bot not connected' });
            }
            
            if (!message || typeof message !== 'string') {
                return res.json({ success: false, message: 'Invalid message' });
            }

            this.sendChatMessage(message);
            res.json({ success: true, message: 'Message sent' });
        });

        // Root endpoint with basic info
        this.app.get('/', (req, res) => {
            res.json({
                name: 'Minecraft Bedrock Discord Bot API',
                version: '1.0.0',
                endpoints: {
                    'GET /': 'This endpoint',
                    'GET /health': 'Health check',
                    'GET /status': 'Detailed bot status',
                    'POST /connect': 'Connect to Minecraft server',
                    'POST /disconnect': 'Disconnect from Minecraft server',
                    'POST /chat': 'Send chat message (requires {message: "text"})'
                },
                minecraft: {
                    server: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`,
                    platform: 'Bedrock Edition',
                    connected: this.isConnected
                }
            });
        });

        // Error handling middleware
        this.app.use((error, req, res, next) => {
            console.error('Web server error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                message: 'Endpoint not found',
                availableEndpoints: ['/', '/health', '/status', '/connect', '/disconnect', '/chat']
            });
        });
    }

    // ========================================================================
    // DISCORD EVENT HANDLERS
    // ========================================================================

    setupDiscordEvents() {
        this.discordClient.once('clientReady', async () => {
            await this.registerSlashCommands();
            await this.setupControlMessage();
        });

        this.discordClient.on('interactionCreate', async (interaction) => {
            if (!interaction.isButton()) return;
            if (interaction.message.id !== this.controlMessage?.id) return;

            if (interaction.customId === 'connect') {
                this.shouldJoin = true;
                this.lastAuthUser = interaction.user;
                this.authInteraction = interaction;
                this.reconnectAttempts = 0;

                const authEmbed = new EmbedBuilder()
                    .setTitle('🔐 Microsoft Authentication Required')
                    .setDescription('Please authenticate to connect the Minecraft Bedrock bot.')
                    .addFields(
                        { name: '⏳ Status', value: 'Connecting to Minecraft server...', inline: false }
                    )
                    .setColor('#ff9900')
                    .setTimestamp();

                await interaction.reply({ 
                    embeds: [authEmbed], 
                    flags: [MessageFlags.Ephemeral]
                });

                this.updateDiscordActivity('⏳ Starting connection...', require('discord.js').ActivityType.Watching);

                await this.connectToMinecraft();

            } else if (interaction.customId === 'disconnect') {
                this.shouldJoin = false;
                this.reconnectAttempts = 0;
                this.authInteraction = null;
                if (this.minecraftBot) {
                    this.minecraftBot.disconnect();
                    this.minecraftBot = null;
                }
                this.updateDiscordActivity('🔴 Standby', require('discord.js').ActivityType.Watching);
                await this.updateEmbed();
                
                await interaction.reply({ 
                    content: '✅ Bot disconnected from Minecraft Bedrock server!', 
                    flags: [MessageFlags.Ephemeral]
                });
            }
        });

        // Handle slash commands
        this.discordClient.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            // Check if command is used in the correct channel
            if (interaction.channelId !== CONFIG.discord.channelId) {
                await interaction.reply({ 
                    content: '❌ This bot can only be used in the designated channel!', 
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            try {
                await this.handleSlashCommand(interaction);
            } catch (error) {
                console.error('Error handling slash command:', error);
                const errorMessage = 'There was an error while executing this command!';
                
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.reply({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
                }
            }
        });
    }

    async setupControlMessage() {
        const channel = await this.discordClient.channels.fetch(CONFIG.discord.channelId);
        if (!channel) {
            console.error('Control channel not found!');
            return;
        }

        const embed = this.createEmbed();
        
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('connect')
                    .setLabel('Connect')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('disconnect')
                    .setLabel('Disconnect')
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Danger)
            );

        this.controlMessage = await channel.send({ 
            embeds: [embed],
            components: [row]
        });
    }

    createEmbed() {
        const statusColor = this.isConnected ? '#00ff00' : this.shouldJoin ? '#ff9900' : '#ff0000';
        const embed = new EmbedBuilder()
            .setTitle('🎮 Minecraft Bedrock AFK Bot')
            .setColor(statusColor)
            .addFields(
                { name: '🖥️ Server', value: `\`${CONFIG.minecraft.host}\``, inline: true },
                { name: '🔗 Status', value: this.getStatusText(), inline: true },
                { name: '🛡️ Safety', value: this.safetyConfig.enabled ? (this.isConnected ? '✅ Active' : '❌ Inactive') : '⏸️ Disabled', inline: true }
            );

        if (this.isConnected) {
            embed.addFields(
                { name: '👤 Player', value: `\`${CONFIG.minecraft.username}\``, inline: true },
                { name: '🌍 World', value: `\`${this.currentWorld}\``, inline: true },
                { name: '❤️ Health', value: `\`${this.currentHealth}/20\``, inline: true },
                { name: '📍 Position', value: `\`${Math.round(this.currentCoords.x)}, ${Math.round(this.currentCoords.y)}, ${Math.round(this.currentCoords.z)}\``, inline: false }
            );
        }

        if (this.reconnectAttempts > 0 && this.shouldJoin) {
            embed.addFields({
                name: '🔄 Reconnecting',
                value: `${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
                inline: true
            });
        }

        embed.setTimestamp()
            .setFooter({ text: 'Use buttons below to control the bot' });

        if (this.authUrl && this.userCode) {
            embed.addFields({
                name: '🔑 Auth Required',
                value: `[Click here](${this.authUrl}) | Code: \`${this.userCode}\``,
                inline: false
            });
        }

        return embed;
    }

    getStatusText() {
        if (this.authUrl && this.userCode) {
            return '⏳ Waiting for Microsoft authentication...';
        }
        if (this.isConnected) {
            return `✅ Connected as ${CONFIG.minecraft.username}`;
        }
        if (this.shouldJoin && !this.isConnected) {
            if (this.reconnectAttempts > 0) {
                return `🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`;
            }
            return '⏳ Connecting...';
        }
        return '❌ Disconnected';
    }

    updatePositionInfo() {
        // Position updates are handled via move_player packets in Bedrock
        if (this.minecraftBot && this.currentCoords) {
            // Coordinates are already updated via packet listeners
        }
    }

    updateDiscordActivity(customStatus = null, activityType = 0) {
        if (!this.discordClient || !this.discordClient.user) return;

        try {
            const { ActivityType } = require('discord.js');
            let status = customStatus;
            
            if (!customStatus) {
                if (this.isConnected) {
                    const safetyStatus = this.safetyConfig.enabled ? '🛡️' : '';
                    status = `${safetyStatus} AFK on ${CONFIG.minecraft.host}`;
                    activityType = ActivityType.Playing;
                } else if (this.shouldJoin) {
                    if (this.authUrl && this.userCode) {
                        status = '🔐 Waiting for auth...';
                        activityType = ActivityType.Watching;
                    } else {
                        status = '⏳ Connecting to server...';
                        activityType = ActivityType.Watching;
                    }
                } else {
                    status = '🔴 Standby';
                    activityType = ActivityType.Watching;
                }
            }

            this.discordClient.user.setActivity(status, { type: activityType });
        } catch (error) {
            console.error('Failed to update Discord activity:', error);
        }
    }

    // ========================================================================
    // SAFETY METHODS
    // ========================================================================

    async sendSafetyAlert(title, description, color = '#ff0000', isUrgent = false) {
        try {
            if (!this.lastAuthUser) {
                console.log('No authenticated user to send safety alert to');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(color)
                .addFields(
                    { name: '📍 **Location**', value: `\`X: ${Math.round(this.currentCoords.x)}, Y: ${Math.round(this.currentCoords.y)}, Z: ${Math.round(this.currentCoords.z)}\``, inline: true },
                    { name: '🌍 **World**', value: `\`${this.currentWorld}\``, inline: true },
                    { name: '❤️ **Health**', value: `\`${this.currentHealth}/20\``, inline: true },
                    { name: '⏰ **Time**', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Bedrock AFK Bot Safety System' });

            const messageContent = isUrgent ? '🚨 **URGENT SAFETY ALERT** 🚨' : '⚠️ **Safety Alert**';
            
            await this.lastAuthUser.send({ 
                content: messageContent, 
                embeds: [embed] 
            });
            
        } catch (error) {
            try {
                const channel = await this.discordClient.channels.fetch(CONFIG.discord.channelId);
                if (channel) {
                    await channel.send({ 
                        content: `⚠️ Failed to DM ${this.lastAuthUser?.tag || 'user'} - Safety Alert: **${title}**\n${description}` 
                    });
                }
            } catch (fallbackError) {
                // Silent error
            }
        }
    }

    checkPlayerProximity() {
        if (!this.safetyConfig.enabled || !this.minecraftBot || !this.isConnected) return;

        const now = Date.now();
        if (now - this.lastProximityAlert < this.safetyConfig.alertCooldown) return;

        if (this.nearbyPlayers.size > 0) {
            this.lastProximityAlert = now;
            const playerList = Array.from(this.nearbyPlayers).map(p => {
                const isTrusted = this.trustedPlayers.has(p) ? '✅' : '⚠️';
                const isBlocked = this.blockedPlayers.has(p) ? '🚫' : '';
                return `${isTrusted}${isBlocked} **${p}**`;
            }).join(', ');
            
            // Check for threats
            const threats = Array.from(this.nearbyPlayers).filter(p => 
                !this.trustedPlayers.has(p)
            );
            
            // Auto-disconnect if threatened by unknown players
            if (this.safetyConfig.autoDisconnectOnThreat && threats.length > 0) {
                const threatList = threats.join(', ');
                this.sendSafetyAlert(
                    '🚨 THREAT DETECTED - AUTO DISCONNECT',
                    `**Untrusted player(s) detected:**\n${threatList}\n\n**Action:** Bot automatically disconnected for safety!`,
                    '#ff0000',
                    true
                );
                setTimeout(() => {
                    this.shouldJoin = false;
                    if (this.minecraftBot) {
                        this.minecraftBot.disconnect();
                    }
                }, 1000);
                return;
            }
            
            this.sendSafetyAlert(
                '⚠️ Player Proximity Alert',
                `**${this.nearbyPlayers.size} player(s) detected:**\n${playerList}`,
                '#ff9900',
                true
            );
        }
    }

    async checkHealth() {
        if (!this.safetyConfig.enabled || !this.minecraftBot || !this.isConnected) return;

        // Check for health decrease (taking damage)
        if (this.currentHealth < this.lastHealth) {
            const damage = this.lastHealth - this.currentHealth;
            
            // Auto-disconnect if health drops below critical threshold
            if (this.currentHealth <= this.safetyConfig.autoDisconnectHealth) {
                this.sendSafetyAlert(
                    '🚨 CRITICAL HEALTH - AUTO DISCONNECT',
                    `**You took ${damage} damage! Health: ${this.currentHealth}/20**\n\n**Action:** Bot automatically disconnected for safety!`,
                    '#8B0000',
                    true
                );
                setTimeout(() => {
                    this.shouldJoin = false;
                    if (this.minecraftBot) {
                        this.minecraftBot.disconnect();
                    }
                }, 500);
                return;
            }
            
            this.sendSafetyAlert(
                '🩸 Damage Taken',
                `**You took ${damage} damage!**\nHealth decreased from ${this.lastHealth} to ${this.currentHealth}`,
                '#ff0000',
                true
            );
        }

        this.lastHealth = this.currentHealth;

        // Check for low health warning
        const now = Date.now();
        if (this.currentHealth <= this.safetyConfig.minHealth && 
            now - this.lastHealthAlert > this.safetyConfig.alertCooldown) {
            
            this.lastHealthAlert = now;
            this.sendSafetyAlert(
                '💀 Critical Health Alert',
                `**DANGER: Health is critically low at ${this.currentHealth}/20!**\nConsider disconnecting immediately!`,
                '#8B0000',
                true
            );
        }
    }

    sendChatMessage(message) {
        if (!this.minecraftBot || !this.isConnected) return;

        try {
            this.minecraftBot.queue('command_request', {
                command: message.startsWith('/') ? message : `/say ${message}`,
                origin: {
                    type: 'player',
                    uuid: '',
                    request_id: ''
                },
                internal: false
            });
        } catch (error) {
            console.error('Failed to send chat message:', error);
        }
    }

    async attemptReconnect() {
        if (!this.shouldJoin) {
            return;
        }

        if (this.isConnecting) {
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.shouldJoin = false;
            await this.updateEmbed();
            return;
        }

        this.reconnectAttempts++;
        await this.updateEmbed();

        const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

        setTimeout(async () => {
            if (this.shouldJoin && !this.isConnected && !this.isConnecting) {
                await this.connectToMinecraft();
            }
        }, delay);
    }

    // ========================================================================
    // MINECRAFT BEDROCK CONNECTION
    // ========================================================================

    async connectToMinecraft() {
        if (this.isConnecting) {
            return;
        }

        if (this.minecraftBot) {
            try {
                this.minecraftBot.disconnect();
            } catch (e) {}
        }

        try {
            this.isConnecting = true;
            await this.updateEmbed();

            console.log('Creating Bedrock client...');
            
            this.minecraftBot = createClient({
                host: CONFIG.minecraft.host,
                port: CONFIG.minecraft.port,
                username: CONFIG.minecraft.username,
                offline: CONFIG.minecraft.offline,
                profilesFolder: CONFIG.minecraft.profilesFolder,
                auth: CONFIG.minecraft.auth
            });

            this.setupMinecraftEvents();

        } catch (error) {
            console.error('Failed to create Bedrock client:', error);
            this.isConnecting = false;
            if (this.shouldJoin) {
                await this.attemptReconnect();
            } else {
                await this.updateEmbed();
            }
        }
    }

    setupMinecraftEvents() {
        // Connection established
        this.minecraftBot.on('join', async () => {
            console.log('Bot connected to Bedrock server!');
            this.isConnected = true;
            this.isConnecting = false;
            this.authUrl = null;
            this.userCode = null;
            this.authMessageSent = false;
            this.reconnectAttempts = 0;

            if (this.authInteraction) {
                try {
                    const successEmbed = new EmbedBuilder()
                        .setTitle('✅ Authentication Successful')
                        .setDescription(`Connected to Minecraft Bedrock server as **${CONFIG.minecraft.username}**!`)
                        .setColor('#00ff00')
                        .setTimestamp();

                    await this.authInteraction.editReply({ 
                        embeds: [successEmbed]
                    });
                    
                    this.authInteraction = null;
                } catch (error) {
                    // Silent error
                }
            }

            this.updateDiscordActivity();
            await this.updateEmbed();

            // Send initial TPA request
            setTimeout(() => {
                if (this.minecraftBot && this.isConnected) {
                    this.sendChatMessage('/tpa doggomc');
                }
            }, 5000);
        });

        // Handle spawn event
        this.minecraftBot.on('spawn', async () => {
            console.log('Bot spawned in Bedrock world');
            this.updateDiscordActivity();
            await this.updateEmbed();
        });

        // Handle player position updates
        this.minecraftBot.on('move_player', (packet) => {
            if (packet && packet.position) {
                this.currentCoords = {
                    x: packet.position.x || 0,
                    y: packet.position.y || 0,
                    z: packet.position.z || 0
                };
            }
        });

        // Handle set_health packet
        this.minecraftBot.on('set_health', (packet) => {
            if (packet && typeof packet.health !== 'undefined') {
                this.lastHealth = this.currentHealth;
                this.currentHealth = packet.health;
                this.checkHealth();
            }
        });

        // Handle chat messages (multiple packet types for Bedrock)
        this.minecraftBot.on('text', (packet) => {
            if (!packet) return;
            const sender = packet.source_name || packet.sender || 'server';
            const message = packet.message || packet.rawtext || 
                           (packet.parameters ? packet.parameters.join(' ') : '') || '';
            
            if (message) {
                console.log(`💬 [${sender}] ${message}`);
            }
        });

        this.minecraftBot.on('player_chat', (packet) => {
            const sender = packet.name || packet.sender || 'player';
            const message = packet.message || '';
            if (message) {
                console.log(`💬 [${sender}] ${message}`);
            }
        });

        // Handle disconnect
        this.minecraftBot.on('disconnect', async (reason) => {
            console.log('Bot disconnected from Bedrock server:', reason);
            this.isConnected = false;
            this.isConnecting = false;
            this.minecraftBot = null;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            this.updateDiscordActivity();
            await this.updateEmbed();

            if (this.shouldJoin) {
                await this.attemptReconnect();
            }
        });

        // Handle errors
        this.minecraftBot.on('error', async (error) => {
            console.error('Bedrock client error:', error);
            this.isConnected = false;
            this.isConnecting = false;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            await this.updateEmbed();

            if (this.shouldJoin) {
                await this.attemptReconnect();
            }
        });

        // Handle kick events
        this.minecraftBot.on('kick', async (reason) => {
            console.log('Bot was kicked from Bedrock server:', reason);
            this.isConnected = false;
            this.isConnecting = false;
            this.minecraftBot = null;
            this.currentWorld = 'Unknown';
            this.currentCoords = { x: 0, y: 0, z: 0 };

            await this.updateEmbed();

            if (this.shouldJoin) {
                await this.attemptReconnect();
            }
        });

        // Handle player list updates
        this.minecraftBot.on('player_list', (packet) => {
            if (packet && packet.records) {
                this.nearbyPlayers.clear();
                for (const record of packet.records.records || []) {
                    if (record.username && record.username !== CONFIG.minecraft.username) {
                        this.nearbyPlayers.add(record.username);
                    }
                }
                this.checkPlayerProximity();
            }
        });

        // Periodic safety checks every 10 seconds
        setInterval(() => {
            if (this.isConnected && this.safetyConfig.enabled) {
                this.checkPlayerProximity();
                this.checkHealth();
            }
        }, 10000);
    }

    async updateEmbed() {
        if (!this.controlMessage) return;

        try {
            const embed = this.createEmbed();
            
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('connect')
                        .setLabel('Connect')
                        .setEmoji('✅')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('disconnect')
                        .setLabel('Disconnect')
                        .setEmoji('❌')
                        .setStyle(ButtonStyle.Danger)
                );

            await this.controlMessage.edit({ 
                embeds: [embed],
                components: [row]
            });
        } catch (error) {
            console.error('Failed to update embed:', error);
        }
    }

    // ========================================================================
    // SLASH COMMANDS
    // ========================================================================

    setupSlashCommands() {
        this.commands = [
            new SlashCommandBuilder()
                .setName('message')
                .setDescription('Send a message to the Minecraft Bedrock server')
                .addStringOption(option =>
                    option.setName('text')
                        .setDescription('The message to send')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('status')
                .setDescription('Show bot connection status'),
            new SlashCommandBuilder()
                .setName('connect')
                .setDescription('Connect the bot to the Minecraft Bedrock server'),
            new SlashCommandBuilder()
                .setName('disconnect')
                .setDescription('Disconnect the bot from the Minecraft Bedrock server'),
            new SlashCommandBuilder()
                .setName('safety')
                .setDescription('Toggle safety monitoring')
                .addBooleanOption(option =>
                    option.setName('enabled')
                        .setDescription('Enable or disable safety monitoring')
                        .setRequired(true)
                )
        ];
    }

    async registerSlashCommands() {
        try {
            const rest = new REST({ version: '10' }).setToken(CONFIG.discord.token);

            await rest.put(
                Routes.applicationCommands(this.discordClient.user.id),
                { body: this.commands.map(command => command.toJSON()) }
            );
        } catch (error) {
            console.error('Error registering slash commands:', error);
        }
    }

    async handleSlashCommand(interaction) {
        const { commandName } = interaction;

        switch (commandName) {
            case 'message':
                await this.handleMessageCommand(interaction);
                break;
            case 'status':
                await this.handleStatusCommand(interaction);
                break;
            case 'connect':
                await this.handleConnectCommand(interaction);
                break;
            case 'disconnect':
                await this.handleDisconnectCommand(interaction);
                break;
            case 'safety':
                await this.handleSafetyCommand(interaction);
                break;
            default:
                await interaction.reply({ content: 'Unknown command!', flags: [MessageFlags.Ephemeral] });
        }
    }

    async handleMessageCommand(interaction) {
        const message = interaction.options.getString('text');

        if (!this.isConnected || !this.minecraftBot) {
            await interaction.reply({ 
                content: '❌ Bot is not connected to the Minecraft Bedrock server!', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        try {
            this.sendChatMessage(message);
            await interaction.reply({ 
                content: `✅ Message sent: "${message}"`, 
                flags: [MessageFlags.Ephemeral] 
            });
        } catch (error) {
            await interaction.reply({ 
                content: '❌ Failed to send message to Minecraft Bedrock server!', 
                flags: [MessageFlags.Ephemeral] 
            });
        }
    }

    async handleStatusCommand(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('🤖 Bedrock Bot Status')
            .setColor(this.isConnected ? '#00ff00' : '#ff0000')
            .addFields(
                { name: '🎮 Minecraft Bedrock', value: this.isConnected ? '✅ Connected' : '❌ Disconnected', inline: true },
                { name: '💬 Discord', value: '✅ Connected', inline: true },
                { name: '🌐 Web Server', value: `✅ Running on port ${CONFIG.webServer.port}`, inline: true }
            );

        if (this.isConnected) {
            embed.addFields(
                { name: '👤 Username', value: CONFIG.minecraft.username || 'Unknown', inline: true },
                { name: '🌍 World', value: this.currentWorld, inline: true },
                { name: '📍 Position', value: `X: ${Math.round(this.currentCoords.x)}, Y: ${Math.round(this.currentCoords.y)}, Z: ${Math.round(this.currentCoords.z)}`, inline: true }
            );
        }

        embed.setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }

    async handleConnectCommand(interaction) {
        if (this.isConnected) {
            await interaction.reply({ 
                content: '✅ Bot is already connected to the Minecraft Bedrock server!', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        this.shouldJoin = true;
        this.reconnectAttempts = 0;
        this.lastAuthUser = interaction.user;
        this.authInteraction = interaction;
        
        await interaction.reply({ 
            content: '🔄 Attempting to connect to the Minecraft Bedrock server...', 
            flags: [MessageFlags.Ephemeral] 
        });

        await this.connectToMinecraft();
    }

    async handleDisconnectCommand(interaction) {
        if (!this.isConnected) {
            await interaction.reply({ 
                content: '❌ Bot is not connected to the Minecraft Bedrock server!', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        this.shouldJoin = false;
        this.reconnectAttempts = 0;
        
        if (this.minecraftBot) {
            this.minecraftBot.disconnect();
            this.minecraftBot = null;
        }
        
        await this.updateEmbed();
        await interaction.reply({ 
            content: '✅ Bot disconnected from the Minecraft Bedrock server!', 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    async handleSafetyCommand(interaction) {
        const enabled = interaction.options.getBoolean('enabled');
        this.safetyConfig.enabled = enabled;

        await this.updateEmbed();

        await interaction.reply({
            content: enabled 
                ? '✅ Safety monitoring **enabled**! You will receive alerts for health drops and nearby players.'
                : '⏸️ Safety monitoring **disabled**.',
            flags: [MessageFlags.Ephemeral]
        });
    }

    // ========================================================================
    // GRACEFUL SHUTDOWN
    // ========================================================================

    async shutdown() {
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }
        if (this.authCheckInterval) {
            clearInterval(this.authCheckInterval);
        }

        if (this.minecraftBot) {
            try {
                this.minecraftBot.disconnect();
            } catch (e) {}
        }

        if (this.discordClient) {
            this.discordClient.destroy();
        }

        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    resolve();
                });
            });
        }
    }
}

// ============================================================================
// STARTUP SEQUENCE
// ============================================================================

StartupLogger.showBanner();

const bot = new MinecraftBedrockDiscordBot();
bot.start().catch((error) => {
    StartupLogger.error(`Startup failed: ${error.message}`);
    process.exit(1);
});

// ============================================================================
// ERROR HANDLING & PROCESS MANAGEMENT
// ============================================================================

const gracefulShutdown = async (signal) => {
    StartupLogger.warning(`Received ${signal}, shutting down gracefully...`);
    try {
        await bot.shutdown();
        StartupLogger.success('Shutdown complete');
        process.exit(0);
    } catch (error) {
        StartupLogger.error(`Error during shutdown: ${error.message}`);
        process.exit(1);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    StartupLogger.error(`Uncaught exception: ${error.message}`);
    console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    StartupLogger.error(`Unhandled rejection: ${reason}`);
    console.error('Promise:', promise);
});
