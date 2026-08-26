"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function checkStatus() {
    try {
        const sessions = await prisma.whatsappSession.findMany();
        console.log('WhatsApp Sessions in Database:');
        console.log(JSON.stringify(sessions, null, 2));
    }
    catch (error) {
        console.error('Error checking WhatsApp session status:', error);
    }
    finally {
        await prisma.$disconnect();
    }
}
checkStatus();
