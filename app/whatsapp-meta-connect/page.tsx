import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { ActionButton } from "@/components/actionButton"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from "@/components/ui/alert-dialog"

export default function WhatsAppMetaConnectPage() {
  return (
    <div className="w-full min-h-screen py-12 px-4 relative">
      <div
        className="fixed inset-0 pointer-events-none z-[-1]"
        style={{
          backgroundImage: `url('/whatsapp-pattern-new.png')`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          width: "100%",
          height: "100%",
        }}
      />

      <div className="max-w-4xl w-full mx-auto">
        <Link href="/" className="inline-flex items-center mb-8 hover:underline" style={{ color: "#128c7e" }}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Voltar para comparação
        </Link>

        <div className="bg-white rounded-xl p-8 shadow-sm">
          <h1 className="text-3xl font-bold mb-6" style={{ color: "#128c7e" }}>
            Conectar WhatsApp Meta
          </h1>
          <p className="text-lg mb-4">Você tem certeza que quer habilitar o Whatsapp Meta?</p>
          <p className="text-lg mb-4">Isso pode ocasionar cobranças adiiconais por conversa criada.</p>
        </div>
        <AlertDialog>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Você tem certeza que deseja conectar o Whatsapp Meta?</AlertDialogTitle>
              <AlertDialogDescription>Isso pode acarretar em cobranças adicionais por conversas criadas.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="px-4 py-2 rounded #128c7e #128c7e text-white">
                Solicitar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ActionButton
          color={"#128c7e"}
          href={"https://doc.clickup.com/9011321034/p/h/8chvp6a-571/7f3c09f78089b64/8chvp6a-691"}
          icon="arrow"
          animationDelay={1000}
          target="_blank"
        >
          Solicitar Ativação
        </ActionButton>
      </div>
    </div>
  )
}
