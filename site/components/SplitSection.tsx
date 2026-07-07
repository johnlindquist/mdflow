import React from 'react';
import { motion } from 'framer-motion';

interface SplitSectionProps {
  index: number;
  title: string;
  subtitle: string;
  description: string;
  leftContent: React.ReactNode;
  rightContent: React.ReactNode;
  reversed?: boolean;
}

export const SplitSection: React.FC<SplitSectionProps> = ({
  index,
  title,
  subtitle,
  description,
  leftContent,
  rightContent,
  reversed = false
}) => {
  return (
    <section className="py-20 px-6 md:px-12 flex flex-col justify-center max-w-7xl mx-auto relative group">

        {/* Giant Watermark Number - Resized for Mobile */}
        <div
            className={`absolute top-20 ${reversed ? 'right-0 md:right-20' : 'left-0 md:left-20'} text-9xl md:text-[20rem] font-display font-bold leading-none text-white/5 select-none -z-10 transition-colors group-hover:text-white/10`}
        >
            0{index + 1}
        </div>

        {/* Content Block - Left align on mobile, conditional right align on desktop */}
        <div className={`mb-16 max-w-2xl relative z-10 ${reversed ? 'lg:ml-auto lg:text-right' : ''}`}>
            <h3 className={`text-orange-400 font-mono text-sm mb-4 uppercase tracking-[0.2em] font-bold flex items-center gap-2 ${reversed ? 'lg:justify-end' : ''}`}>
                {/* Decorative lines: Always show left on mobile. Swap on desktop based on reversed. */}
                {!reversed && <span className="w-8 h-px bg-orange-400"></span>}
                {reversed && <span className="lg:hidden w-8 h-px bg-orange-400"></span>}

                {subtitle}

                {reversed && <span className="hidden lg:block w-8 h-px bg-orange-400 ml-auto"></span>}
            </h3>
            <h2 className="select-none text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white mb-8 tracking-tighter">
                {title}
            </h2>
            <p className={`text-zinc-300 text-lg leading-relaxed border-l-2 border-orange-500/50 pl-6 ${reversed ? 'lg:border-l-0 lg:pl-0 lg:border-r-2 lg:pr-6' : ''}`}>
                {description}
            </p>
        </div>

        {/* Grid Container - Auto height on mobile, fixed 360px on desktop */}
        <div className={`grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-24 items-center h-auto lg:h-[360px] ${reversed ? 'lg:flex-row-reverse' : ''}`}>
            <motion.div
                initial={{ opacity: 0, x: -50 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.7, ease: "easeOut" }}
                viewport={{ once: true, margin: "-100px" }}
                // Fixed height 300px on mobile to prevent collapse, full height on desktop
                className={`w-full relative h-[300px] lg:h-full ${reversed ? 'lg:order-2' : ''}`}
            >
                <div className="absolute -inset-4 bg-gradient-to-r from-orange-500/20 to-amber-500/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                <div className="relative h-full transform transition-transform duration-500 hover:scale-[1.02] hover:-rotate-1">
                    {leftContent}
                </div>
            </motion.div>

            <motion.div
                initial={{ opacity: 0, x: 50 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.7, delay: 0.2, ease: "easeOut" }}
                viewport={{ once: true, margin: "-100px" }}
                // Fixed height 300px on mobile to prevent collapse, full height on desktop
                className={`w-full relative h-[300px] lg:h-full ${reversed ? 'lg:order-1' : ''}`}
            >
                 <div className="absolute -inset-4 bg-gradient-to-r from-blue-500/20 to-cyan-500/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                <div className="relative h-full transform transition-transform duration-500 hover:scale-[1.02] hover:rotate-1">
                    {rightContent}
                </div>
            </motion.div>
        </div>
    </section>
  );
};
