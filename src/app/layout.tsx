import type {Metadata} from "next";
import "./globals.css";
export const metadata:Metadata={title:"PourVentory – Smart stocktaking, simply scanning",description:"Smart stocktaking, simply scanning."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
