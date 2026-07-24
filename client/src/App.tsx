import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Landing from "./pages/Landing";
import Home from "./pages/Home";
import Mailbrief from "./pages/Mailbrief";
import Advisor from "./pages/Advisor";
import CRM from "./pages/CRM";
import NotFound from "./pages/NotFound";
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
    // due to the way the footer is positioned at the bottom of the page.
    <div className="min-h-screen flex flex-col bg-slate-50">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {/* Wrap the Routes in a main tag with flex-grow. 
            This tells the main content area to stretch and fill all available space.*/}
          <main className="flex-grow">
            <Routes>
              <Route path="/" element={<Login />} />
              <Route path="/auth/login" element={<Login />} />
              <Route path="/landing" element={<Landing />}>
                <Route index element={<Home />} />
                <Route path="mailbrief" element={<Mailbrief />} />
                <Route path="advisor" element={<Advisor />} />
                <Route path="crm" element={<CRM />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>

          <Footer />
        </BrowserRouter>
      </QueryClientProvider>
    </div>
  );
}
