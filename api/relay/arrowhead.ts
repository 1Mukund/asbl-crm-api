import { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";

const ARROWHEAD_API_KEY = process.env.ARROWHEAD_API_KEY || "6bc3e659d8c0a012acd36d2cf5ca22a7";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const response = await axios.post(
      "https://api.arrowhead.ai/v2/schedule-call",
      req.body,
      {
        headers: {
          Authorization: `Bearer ${ARROWHEAD_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return res.status(200).json(response.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Arrowhead relay error:", data);
    return res.status(status).json({ error: data });
  }
}
