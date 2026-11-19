#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    drop::cli::run_cli(argv).await;
}
