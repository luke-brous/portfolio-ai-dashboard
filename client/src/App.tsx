import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login"; // Adjust your import paths as needed
import Dashboard from "./pages/Dashboard";
import Footer from "./components/Footer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
    },
  },
});

export default function App() {
  return (
    // The outer div MUST have min-h-screen and flex flex-col
    <div className="min-h-screen flex flex-col bg-slate-50">
      <QueryClientProvider client={queryClient} >
      <BrowserRouter>
        
        {/* Wrap your Routes in a main tag with flex-grow. 
            This tells the main content area to stretch and fill all available space, 
            which violently shoves the footer to the bottom of the page. */}
        <main className="flex-grow">
          <Routes>
            <Route path="/" element={<Login />} />
            <Route path="/auth/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
          </Routes>
        </main>

        <Footer />
        
      </BrowserRouter>
      </QueryClientProvider>
    </div>
  );
}