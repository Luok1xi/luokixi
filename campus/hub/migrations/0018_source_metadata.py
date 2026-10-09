from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('hub', '0017_learning_follow')]
    operations = [migrations.AddField(model_name='source', name='metadata', field=models.JSONField(default=dict, blank=True))]
