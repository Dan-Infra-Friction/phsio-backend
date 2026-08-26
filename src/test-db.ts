import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function test() {
  console.log('Testing Prisma connection...');
  try {
    const userCount = await prisma.user.count();
    console.log('Successfully connected to database!');
    console.log(`Total users in database: ${userCount}`);
    
    const patientCount = await prisma.patient.count();
    console.log(`Total patients in database: ${patientCount}`);
  } catch (error) {
    console.error('Database connection or query failed:');
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

test();
