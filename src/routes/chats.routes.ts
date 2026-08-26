import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  getConversations,
  getMessages,
  toggleAiOverride,
  getIncomingMessages,
  markAsRead,
  deleteChat,
  restartChat,
  sendMessage,
} from '../controllers/chats.controller';

const router = Router();

router.use(protect);

router.get('/conversations', getConversations);
router.get('/incoming-messages', getIncomingMessages);

// Support both flat and nested routes
router.get('/:conversationId/messages', getMessages);
router.get('/conversations/:conversationId/messages', getMessages);

router.post('/:conversationId/messages', sendMessage);
router.post('/conversations/:conversationId/messages', sendMessage);

router.put('/:conversationId/toggle-ai', toggleAiOverride);
router.put('/conversations/:conversationId/toggle-ai', toggleAiOverride);
router.patch('/conversations/:conversationId/ai-toggle', toggleAiOverride);
router.put('/conversations/:conversationId/ai-toggle', toggleAiOverride);

router.put('/:conversationId/read', markAsRead);
router.put('/conversations/:conversationId/read', markAsRead);

router.delete('/:conversationId', deleteChat);
router.delete('/conversations/:conversationId', deleteChat);

router.post('/:conversationId/restart', restartChat);
router.post('/conversations/:conversationId/restart', restartChat);

export default router;
