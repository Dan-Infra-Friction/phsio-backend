import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/db';
import { WhatsappService } from '../services/whatsapp.service';

const JWT_SECRET = process.env.JWT_SECRET || 'physiobot_jwt_secret_key_2026_change_me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'physiobot_jwt_refresh_secret_key_2026_change_me';

const generateTokens = (user: { id: string; email: string; role: string }) => {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '1d' }
  );

  const refreshToken = jwt.sign(
    { id: user.id },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
};

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, and password.',
      });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already in use.',
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user along with default clinic settings
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        settings: {
          create: {}, // creates default setting as defined in the prisma schema
        },
      },
      include: {
        settings: true,
      },
    });

    const { accessToken, refreshToken } = generateTokens(user);

    return res.status(201).json({
      success: true,
      message: 'User registered successfully.',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password.',
      });
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { email },
      include: { settings: true },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect email or password.',
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const refresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required.',
      });
    }

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as { id: string };

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists.',
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired refresh token.',
    });
  }
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and new password.',
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with that email address.',
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    return res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now log in with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

// In-memory OTP store (email -> { code, expiresAt })
const otpStore = new Map<string, { code: string; expiresAt: Date }>();

export const sendWhatsappOtp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { whatsappSession: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with that email address.',
      });
    }

    const session = user.whatsappSession;
    if (!session || !session.phone || session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp is not connected for this account. Please connect WhatsApp in Settings first.',
      });
    }

    const client = WhatsappService.getClient(user.id);
    if (!client) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp client is currently disconnected. Please reconnect WhatsApp first.',
      });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    otpStore.set(email.toLowerCase(), { code, expiresAt });

    // Send via WhatsApp
    const target = `${session.phone}@c.us`;
    await client.sendMessage(target, `[PhysioBot] Your verification code is: ${code}. This code will expire in 5 minutes.`);

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your connected WhatsApp number successfully.',
    });
  } catch (error) {
    next(error);
  }
};

export const verifyWhatsappOtp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and OTP code.',
      });
    }

    const record = otpStore.get(email.toLowerCase());

    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'No OTP requested for this email, or it has expired.',
      });
    }

    if (new Date() > record.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.',
      });
    }

    if (record.code !== code.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Incorrect OTP code. Please try again.',
      });
    }

    // Clear OTP after successful use
    otpStore.delete(email.toLowerCase());

    const user = await prisma.user.findUnique({
      where: { email },
      include: { settings: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User no longer exists.',
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};
