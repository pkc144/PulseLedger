import { Features } from '../components/landing/Features';
import { Footer } from '../components/landing/Footer';
import { Hero } from '../components/landing/Hero';
import { HowItWorks } from '../components/landing/HowItWorks';
import { Navbar } from '../components/landing/Navbar';
import { Operations } from '../components/landing/Operations';
import { Security } from '../components/landing/Security';

export function Landing() {
  return (
    <div className="min-h-screen bg-ink-950 text-slate-200 selection:bg-pulse-400/30">
      <Navbar />
      <main id="main">
        <Hero />
        <Features />
        <HowItWorks />
        <Security />
        <Operations />
      </main>
      <Footer />
    </div>
  );
}
