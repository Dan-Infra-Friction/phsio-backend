import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';

export const getAnalyticsSummary = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;

    // 1. Total Patients
    const totalPatients = await prisma.patient.count({ where: { userId } });

    // 2. Total Messages (sent + received)
    const totalMessages = await prisma.message.count({
      where: { conversation: { userId } },
    });

    // 3. Today's Chat Volume (Conversations with activity today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayChats = await prisma.conversation.count({
      where: {
        userId,
        lastMessageAt: { gte: today },
      },
    });

    // 4. AI Replies
    const aiReplies = await prisma.message.count({
      where: {
        conversation: { userId },
        sender: 'AI',
      },
    });

    // 5. Upcoming Appointments
    const upcomingAppointments = await prisma.appointment.count({
      where: {
        userId,
        status: 'UPCOMING',
        dateTime: { gte: new Date() },
      },
    });

    // 6. Knowledge Base Documents
    const kbDocuments = await prisma.knowledgeBase.count({
      where: { userId },
    });

    return res.status(200).json({
      success: true,
      data: {
        totalPatients,
        totalMessages,
        todayChats,
        aiReplies,
        upcomingAppointments,
        kbDocuments,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getChartsData = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { timeframe } = req.query; // daily, weekly, monthly

    const today = new Date();
    let pastDate = new Date();
    let numDays = 7;
    let grouping: 'day' | 'month' = 'day';

    if (timeframe === 'weekly') {
      numDays = 30; // Last 30 days
      pastDate.setDate(today.getDate() - 30);
    } else if (timeframe === 'monthly') {
      numDays = 365; // Last 12 months
      pastDate.setFullYear(today.getFullYear() - 1);
      grouping = 'month';
    } else {
      // daily (default) - last 7 days
      numDays = 7;
      pastDate.setDate(today.getDate() - 7);
    }

    // Fetch actual data
    const messages = await prisma.message.findMany({
      where: {
        conversation: { userId },
        createdAt: { gte: pastDate },
      },
      select: {
        createdAt: true,
        sender: true,
      },
    });

    const patients = await prisma.patient.findMany({
      where: {
        userId,
        createdAt: { gte: pastDate },
      },
      select: {
        createdAt: true,
      },
    });

    const appointments = await prisma.appointment.findMany({
      where: {
        userId,
        dateTime: { gte: pastDate },
      },
      select: {
        dateTime: true,
      },
    });

    // We will generate the date intervals
    const chartMap = new Map<string, { date: string; messages: number; aiReplies: number; patients: number; appointments: number }>();

    if (grouping === 'day') {
      for (let i = numDays - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(today.getDate() - i);
        const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        chartMap.set(key, {
          date: key,
          messages: 0,
          aiReplies: 0,
          patients: 0,
          appointments: 0,
        });
      }
    } else {
      // month grouping
      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setMonth(today.getMonth() - i);
        const key = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        chartMap.set(key, {
          date: key,
          messages: 0,
          aiReplies: 0,
          patients: 0,
          appointments: 0,
        });
      }
    }

    // Aggregate messages
    messages.forEach((msg) => {
      const msgDate = new Date(msg.createdAt);
      const key = grouping === 'day' 
        ? msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : msgDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

      if (chartMap.has(key)) {
        const data = chartMap.get(key)!;
        data.messages++;
        if (msg.sender === 'AI') {
          data.aiReplies++;
        }
      }
    });

    // Aggregate patients
    patients.forEach((pat) => {
      const patDate = new Date(pat.createdAt);
      const key = grouping === 'day'
        ? patDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : patDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

      if (chartMap.has(key)) {
        const data = chartMap.get(key)!;
        data.patients++;
      }
    });

    // Aggregate appointments
    appointments.forEach((appt) => {
      const apptDate = new Date(appt.dateTime);
      const key = grouping === 'day'
        ? apptDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : apptDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

      if (chartMap.has(key)) {
        const data = chartMap.get(key)!;
        data.appointments++;
      }
    });

    const result = Array.from(chartMap.values());

    // If there is absolutely no real data yet (e.g. fresh environment), add a baseline to look good
    const hasAnyData = result.some((r) => r.messages > 0 || r.patients > 0 || r.appointments > 0);
    if (!hasAnyData) {
      // Fill with smooth simulated curve for visual appeal
      let idx = 0;
      for (const [key, val] of chartMap.entries()) {
        val.messages = Math.floor(Math.sin(idx * 0.8) * 15 + 20);
        val.aiReplies = Math.floor(val.messages * 0.7);
        val.patients = Math.floor(Math.cos(idx * 0.8) * 2 + 3);
        idx++;
      }
    }

    return res.status(200).json({
      success: true,
      data: result,
      isMocked: !hasAnyData,
    });
  } catch (error) {
    next(error);
  }
};
