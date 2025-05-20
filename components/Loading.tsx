import React from "react";

const Loading: React.FC = () => {
    return (
        <div className="transition-all fixed inset-0 z-50 flex items-center justify-center bg-[#ffffffcc] bg-opacity-50">
            <div className="w-16 h-16 border-4 border-blue-800 border-t-transparent rounded-full animate-spin"></div>
        </div>
    );
};

export default Loading;
