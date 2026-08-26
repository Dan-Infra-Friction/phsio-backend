import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fetchMessages() {
  try {
    const messages = await prisma.message.findMany({
      where: {
        sender: 'PATIENT', // Only incoming messages from patients
      },
      include: {
        conversation: {
          include: {
            patient: true,
          },
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 20, // Fetch the 20 most recent messages
    });

    console.log(JSON.stringify(messages, null, 2));
  } catch (error) {
    console.error('Error fetching messages:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fetchMessages();
