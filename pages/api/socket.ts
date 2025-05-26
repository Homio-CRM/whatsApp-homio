import { Server } from 'socket.io';
import type { NextApiRequest } from 'next';
import type { NextApiResponseServerIO } from '@/types/socket';
import { setIO } from '@/lib/socketServer';

export default function handler(req: NextApiRequest, res: NextApiResponseServerIO) {
    if (!res.socket.server.io) {

        const io = new Server(res.socket.server, {
            path: '/api/socket_io',
            addTrailingSlash: false,
            cors: {
                origin: '*',
            },
        });
        setIO(io);
        io.on('connection', socket => {
            socket.on('disconnect', () => {
            });
        });

        res.socket.server.io = io;
    } else {
        console.log('Socket já existente');
    }
    res.end();
}
