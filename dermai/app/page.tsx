"use client";

import { Message } from "ai";
import { useChat } from "@ai-sdk/react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import crypto from "crypto";
import { createClient } from "@/supabase/client";
import { Tables } from "@/database.types";

// Custom components
import ChatContainer from "@/components/ChatContainer";
import AnalysisResults from "@/components/AnalysisResults";
import ImageUpload from "@/components/ImageUpload";
import PasswordProtection from "@/components/PasswordProtection";
import Link from "next/link";

export default function Chat({ id }: { id?: string }) {
  // State management
  const [files, setFiles] = useState<File[]>([]);
  const [chatLoading, setChatLoading] = useState<boolean>(true);
  const [chat, setChat] = useState<Tables<"chats"> | null>(null);
  // Add this state to track elapsed time
  const [classificationTime, setClassificationTime] = useState<string>("0.0s");
  const [classificationTimer, setClassificationTimer] =
    useState<NodeJS.Timeout | null>(null);

  const [classification, setClassification] = useState<{
    image_id: string;
    confidence: number;
    predicted_class: string;
  } | null>(null);
  const [password, setPassword] = useState<boolean>(true);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [toolCall, setToolCall] = useState<string>();
  const s = createClient();

  // Add this function to start the timer
  const startClassificationTimer = () => {
    const startTime = Date.now();

    const timer = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setClassificationTime(`${elapsed.toFixed(1)}s`);
    }, 100);

    setClassificationTimer(timer);
  };

  // Create an initial welcome message
  const initialWelcomeMessage: Message = {
    id: "welcome-message",
    role: "assistant",
    content:
      "Welcome to DermAI! I'm your skin health assistant. How can I help you today?",
    createdAt: new Date(),
  };

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    setMessages,
    append,
  } = useChat({
    maxSteps: 3,
    onToolCall({ toolCall }) {
      setToolCall(toolCall.toolName);
    },
    streamProtocol: "data",
    onError: (error) => {
      console.error(error);
      toast.error("You've been rate limited, please try again later!", {
        description: error.message,
      });
    },
  });

  const createAnalysisPrompt = (condition: string): Message => {
    return {
      id: `prompt-${Date.now()}`,
      role: "user",
      content: `The image analysis detected ${condition}. Please provide information about this condition and suggest the next steps the user should take. Make sure to highlight that this is educational information only and not medical advice.`,
      createdAt: new Date(),
    };
  };

  // Classification API mutation
  const mutation = useMutation({
    mutationFn: async (id: string) => {
      startClassificationTimer();
      const response = await axios.post("/api/classify", { id });
      return response.data;
    },
    onSuccess: async (data) => {
      if (classificationTimer) {
        clearInterval(classificationTimer);
        setClassificationTimer(null);

        // fetch the classification
      }
      if (!id) return;

      console.log("Data posted successfully!");
      // Update Supabase
      const { data: updatedData, error } = await s
        .from("chats")
        .update({ classification: data.predicted_class })
        .eq("id", id)
        .select("*");

      if (error || !updatedData) {
        console.error("Error updating Supabase:", error);
      }

      console.log(updatedData);
      setClassification({
        predicted_class: updatedData[0].classification,
        confidence: updatedData[0].confidence,
        image_id: updatedData[0].image_id,
      });

      append({
        role: "user",
        content: `The image analysis detected ${data.predicted_class}. What are the next steps I should take?`,
      });
    },
    onError: (error) => {
      // Clear the timer on error too
      if (classificationTimer) {
        clearInterval(classificationTimer);
        setClassificationTimer(null);
      }

      console.error("Error posting data:", error);
      toast.error("Failed to connect to classification service");
      setClassification(null);
    },
  });

  // Get chat data when ID exists
  const getChat = async () => {
    if (!id) return;

    const { data, error } = await s
      .from("chats")
      .select("*")
      .eq("id", id)
      .single();

    setChatLoading(false);

    if (error || !data) {
      toast.error(error ? "Failed to get chat" : "Chat not found");
      return;
    }

    setChat(data);

    // Set messages from stored data or use welcome message
    try {
      const parsedMessages = JSON.parse(data?.messages || "[]");
      setMessages(
        parsedMessages.length > 0 ? parsedMessages : [initialWelcomeMessage],
      );
    } catch (e) {
      setMessages([initialWelcomeMessage]);
    }

    // Verify password
    const storedPassword = localStorage.getItem(`chatPassword`);
    if (storedPassword && storedPassword === data?.password) {
      setPassword(true);

      // Trigger classification if not already done
      if (!data.classification) {
        await mutation.mutateAsync(data.id);
      } else {
        setClassification({
          predicted_class: data.classification,
          confidence: data.confidence,
          image_id: "",
        });

        // Check if we already have an analysis message
        const hasAnalysisMessage = JSON.parse(data?.messages || "[]").some(
          (msg: Message) =>
            msg.role === "system" && msg.content.includes("Analysis complete"),
        );

        // If no analysis message exists yet, add it and trigger a response
        if (!hasAnalysisMessage) {
          const analysisMessage: Message = {
            id: `analysis-${Date.now()}`,
            role: "system",
            content: `Analysis complete. Detected skin condition: ${data.classification}`,
            createdAt: new Date(),
          };

          // Add both the analysis message and prompt for suggestions
          setMessages((prevMessages) => [
            ...prevMessages,
            analysisMessage,
            createAnalysisPrompt(data.classification),
          ]);
        }
      }
    } else {
      setPassword(false);
      toast.error("Password doesn't match or not provided");
    }
  };

  // Upload files and create new chat
  const uploadToSupabase = async () => {
    if (id || !files.length) return;

    try {
      // Create a new chat record
      const { data: chat, error: err } = await s
        .from("chats")
        .insert({
          password: crypto
            .createHash("sha256")
            .update(Math.random().toString())
            .digest("hex")
            .substring(0, 10),
        })
        .select("*")
        .single();

      if (!chat) {
        toast.error("Failed to create chat");
        console.log(err);
        return;
      }

      // Upload the image to storage
      const { data, error } = await s.storage
        .from("images")
        .upload(`${chat.id}/${files[0].name}`, files[0], {
          cacheControl: "3600",
          upsert: false,
        });

      if (error || !data) {
        toast.error(error.message);
        return;
      }

      // Store password in local storage
      localStorage.setItem("chatPassword", chat?.password);

      // Save messages if any exist
      if (messages.length > 0) {
        await s
          .from("chats")
          .update({
            messages: messages,
          })
          .eq("id", chat.id);
      }

      // Redirect to new chat
      window.location.href = `/${chat.id}`;
    } catch (error) {
      toast.error("Error creating chat");
      console.error(error);
    }
  };

  // Initialize with welcome message for new chats
  useEffect(() => {
    if (id) return;
    if (messages.length === 0) {
      setMessages([initialWelcomeMessage]);
    }
  }, []);

  // Handle chat expansion and update messages in Supabase
  useEffect(() => {
    if (messages.length > 0) setIsExpanded(true);

    // Update messages in Supabase for existing chats
    const updateSupabase = async () => {
      if (!id) return;
      console.log("Updating Supabase");
      try {
        await s
          .from("chats")
          .update({
            messages: JSON.stringify(messages),
          })
          .eq("id", id);
      } catch (error) {
        console.error("Error updating message status:", error);
      }
    };

    if (id) {
      updateSupabase();
    }
    console.log(messages);
  }, [messages, id]);

  // Fetch chat data when ID is available
  useEffect(() => {
    if (!id) return;
    getChat();
  }, [id]);

  useEffect(() => {
    return () => {
      if (classificationTimer) {
        clearInterval(classificationTimer);
      }
    };
  }, [classificationTimer]);

  // Render loading or unauthorized state
  if (!chat && id) {
    if (chatLoading) {
      return <PasswordProtection isLoading={true} />;
    }
  }

  if (id && !password) {
    return <PasswordProtection isLoading={false} />;
  }
  return (
    <div className="relative min-h-screen w-full">
      <div className="absolute h-full w-full bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]"></div>
      {/* Header */}
      <div className="relative flex flex-col items-center w-full z-20">
        <header className="w-full max-w-3xl text-center mb-8 pt-8 md:pt-12">
          <Link href="/">
            <motion.h1
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-4xl md:text-5xl lg:text-6xl font-bold mb-3 bg-gradient-to-r from-neutral-800 to-neutral-600 dark:from-neutral-200 dark:to-neutral-400 text-transparent bg-clip-text"
            >
              DermAI
            </motion.h1>
          </Link>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-neutral-600 dark:text-neutral-300 text-lg md:text-xl max-w-xl mx-auto"
          >
            Your AI-powered assistant for skin health education and information
          </motion.p>
        </header>
        {/* Analysis Results */}
        {id && (
          <section className="w-full max-w-3xl mb-8">
            <AnalysisResults
              classificationTime={classificationTime}
              mutation={mutation}
              classification={classification}
            />
          </section>
        )}
        {/* Image Upload (for new chats) */}
        {!id && (
          <ImageUpload
            files={files}
            setFiles={setFiles}
            handleUpload={uploadToSupabase}
          />
        )}
        {/* Chat Container */}
        <div className="flex flex-col items-center w-full max-w-3xl">
          <ChatContainer
            isExpanded={isExpanded}
            messages={messages}
            status={status}
            input={input}
            handleInputChange={handleInputChange}
            handleSubmit={handleSubmit}
            toolCall={toolCall}
          />

          <div className="text-center text-xs text-neutral-500 dark:text-neutral-400 mt-4">
            <p>
              DermAI provides educational information only. Always consult a
              healthcare professional for medical advice.
            </p>
          </div>

          {/* Sources Information */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="mt-10 mb-8 w-full max-w-3xl border-t border-neutral-200 dark:border-neutral-700 pt-6"
          >
            <h3 className="text-center text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-4">
              Our Information Sources
            </h3>
            <div className="prose prose-sm dark:prose-invert max-w-none text-neutral-600 dark:text-neutral-400 prose-p:leading-relaxed prose-headings:mb-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">ScienceDirect Topics</h4>
                  <p className="text-xs">
                    A highly credible resource that compiles expert summaries
                    from peer-reviewed scientific literature, ensuring accuracy
                    and reliability in academic and medical topics.
                  </p>
                </div>

                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">PMC (PubMed Central)</h4>
                  <p className="text-xs">
                    A trusted, government-maintained archive of biomedical and
                    life sciences journal articles, sourced from reputable,
                    peer-reviewed publications.
                  </p>
                </div>

                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">Cleveland Clinic</h4>
                  <p className="text-xs">
                    A world-renowned nonprofit medical center recognized for its
                    evidence-based healthcare, extensive medical research, and
                    expert-reviewed health information.
                  </p>
                </div>

                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">Johns Hopkins Medicine</h4>
                  <p className="text-xs">
                    One of the most prestigious academic medical institutions,
                    known for its groundbreaking research, world-class
                    healthcare, and contributions to medical advancements.
                  </p>
                </div>

                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">NIAMS (NIH)</h4>
                  <p className="text-xs">
                    A division of the U.S. National Institutes of Health (NIH),
                    ensuring authoritative, research-backed information on
                    arthritis, musculoskeletal, and skin diseases.
                  </p>
                </div>

                <div className="flex flex-col space-y-1">
                  <h4 className="font-medium">BC Centre for Disease Control</h4>
                  <p className="text-xs">
                    A government-funded public health authority that provides
                    reliable disease prevention guidance and epidemiological
                    research.
                  </p>
                </div>

                <div className="flex flex-col space-y-1 md:col-span-2">
                  <h4 className="font-medium">Mayo Clinic</h4>
                  <p className="text-xs">
                    A globally respected nonprofit medical organization, known
                    for its rigorous scientific research, expert-reviewed
                    medical advice, and commitment to patient care excellence.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* add sources info here */}
        </div>
      </div>
    </div>
  );
}
