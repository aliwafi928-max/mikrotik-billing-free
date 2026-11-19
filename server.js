if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Aplikasi Billing berjalan di port ${PORT}`));
}

module.exports = app;
