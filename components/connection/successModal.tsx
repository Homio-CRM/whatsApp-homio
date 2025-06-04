"use client"

import { motion } from "framer-motion";

const SuccessModal = () => (
    <motion.div
        initial={{
            width: 60,
            height: 60,
            borderRadius: "50%",
            top: "50%",
            left: "50%",
            x: "-50%",
            y: "-50%",
            position: "fixed",
            backgroundColor: "#22c55e",
            opacity: 0,
        }}
        animate={{
            width: "200vmax",
            height: "200vmax",
            opacity: 1,
            transition: {
                duration: 1,
                ease: "easeInOut",
            },
        }}
        className="z-50 flex items-center justify-center"
    >
        <div className="absolute inset-0 flex items-center justify-center flex-col text-white text-center px-4">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                height="96px"
                viewBox="0 -960 960 960"
                width="96px"
                fill="white"
            >
                <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
            </svg>
            <h2 className="text-3xl font-bold mt-6">WhatsApp Meta solicitado!</h2>
            <p className="text-lg mt-2">Em até 24 horas, ele será liberado.</p>
        </div>
    </motion.div>
);

export default SuccessModal;
