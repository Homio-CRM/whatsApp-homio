import { NextApiRequest } from 'next';
import type { NextApiResponseServerIO } from '@/types/socket';

export default function handler(req: NextApiRequest, res: NextApiResponseServerIO) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }
    const io = res.socket.server.io;
    if (!io) {
        return res.status(500).json({ message: 'WebSocket não inicializado' });
    }
    io.emit('connection-update', req.body);

    return res.status(200).json({ ok: true });
}
