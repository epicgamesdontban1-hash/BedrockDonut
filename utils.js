class StartupLogger {
    static showBanner() {
        console.log('\n');
        console.log('\x1b[35m' + '╔══════════════════════════════════════════════════════════════╗' + '\x1b[0m');
        console.log('\x1b[35m' + '║                                                              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '██████╗  ██████╗  ██████╗  ██████╗  ██████╗' + '\x1b[35m' + '              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '██╔══██╗██╔═══██╗██╔════╝ ██╔════╝ ██╔═══██╗' + '\x1b[35m' + '             ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '██║  ██║██║   ██║██║  ███╗██║  ███╗██║   ██║' + '\x1b[35m' + '             ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '██║  ██║██║   ██║██║   ██║██║   ██║██║   ██║' + '\x1b[35m' + '             ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝' + '\x1b[35m' + '             ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║  ' + '\x1b[36m' + '╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝' + '\x1b[35m' + '              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║                                                              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║         ' + '\x1b[33m' + 'Minecraft Discord Bot - Initializing...' + '\x1b[35m' + '              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '║                                                              ║' + '\x1b[0m');
        console.log('\x1b[35m' + '╚══════════════════════════════════════════════════════════════╝' + '\x1b[0m');
        console.log('\n');
    }

    static showStatus(services) {
        console.log('\x1b[1m' + '📊 SERVICE STATUS:' + '\x1b[0m');
        console.log('─'.repeat(60));
        
        for (const service of services) {
            const status = service.status ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
            const statusText = service.status ? '\x1b[32mONLINE\x1b[0m' : '\x1b[31mOFFLINE\x1b[0m';
            console.log(`${status} ${service.name.padEnd(20)} ${statusText}${service.details ? ' - ' + service.details : ''}`);
        }
        
        console.log('─'.repeat(60));
        
        const allOnline = services.every(s => s.status);
        if (allOnline) {
            console.log('\x1b[32m\x1b[1m✓ All services operational!\x1b[0m\n');
        } else {
            console.log('\x1b[31m\x1b[1m✗ Some services failed to start!\x1b[0m\n');
        }
    }

    static info(message) {
        console.log('\x1b[34mℹ\x1b[0m ' + message);
    }

    static success(message) {
        console.log('\x1b[32m✓\x1b[0m ' + message);
    }

    static error(message) {
        console.log('\x1b[31m✗\x1b[0m ' + message);
    }

    static warning(message) {
        console.log('\x1b[33m⚠\x1b[0m ' + message);
    }
}

module.exports = { StartupLogger };
